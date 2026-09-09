package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	cryptossh "golang.org/x/crypto/ssh"
)

// FakeServer is an in-process SSH server for isolation tests.
type FakeServer struct {
	Addr           string
	HostSigner     cryptossh.Signer
	Fingerprint    string
	UserSigner     cryptossh.Signer
	Username       string
	Password       string
	Delay          time.Duration
	Stdout         string
	ExitStatus     uint32
	// OnExec overrides stdout/exit per recorded command. Used by E8.3
	// verification tests. Returning a non-nil *status uses that exit code.
	OnExec func(cmd string) (stdout string, status uint32)
	mu     sync.Mutex
	listener       net.Listener
	authMethods    []string
	passwords      []string
	channelTypes   []string
	requestTypes   []string
	commands       []string
	acceptedPubkey bool
}

// StartFakeServer listens on 127.0.0.1 and accepts one or more SSH clients.
func StartFakeServer() (*FakeServer, error) {
	host, err := generateSigner()
	if err != nil {
		return nil, err
	}
	user, err := generateSigner()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &FakeServer{
		Addr:        ln.Addr().String(),
		HostSigner:  host,
		Fingerprint: PublicKeyFingerprint(host.PublicKey()),
		UserSigner:  user,
		Username:    DefaultUsername,
		Stdout:      "ok",
		listener:    ln,
	}
	go s.serve()
	return s, nil
}

func generateSigner() (cryptossh.Signer, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return cryptossh.NewSignerFromKey(priv)
}

func (s *FakeServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *FakeServer) handle(nConn net.Conn) {
	cfg := &cryptossh.ServerConfig{
		PasswordCallback: func(conn cryptossh.ConnMetadata, password []byte) (*cryptossh.Permissions, error) {
			s.recordAuth("password")
			s.mu.Lock()
			s.passwords = append(s.passwords, string(password))
			s.mu.Unlock()
			if s.Password != "" && string(password) == s.Password && conn.User() == s.Username {
				return nil, nil
			}
			return nil, fmt.Errorf("password denied")
		},
		PublicKeyCallback: func(conn cryptossh.ConnMetadata, key cryptossh.PublicKey) (*cryptossh.Permissions, error) {
			s.recordAuth("publickey")
			if conn.User() != s.Username {
				return nil, fmt.Errorf("user denied")
			}
			if cryptossh.FingerprintSHA256(key) == cryptossh.FingerprintSHA256(s.UserSigner.PublicKey()) {
				s.mu.Lock()
				s.acceptedPubkey = true
				s.mu.Unlock()
				return nil, nil
			}
			return nil, fmt.Errorf("public key denied")
		},
	}
	cfg.AddHostKey(s.HostSigner)

	conn, chans, reqs, err := cryptossh.NewServerConn(nConn, cfg)
	if err != nil {
		_ = nConn.Close()
		return
	}
	defer conn.Close()
	go cryptossh.DiscardRequests(reqs)
	for newCh := range chans {
		s.mu.Lock()
		s.channelTypes = append(s.channelTypes, newCh.ChannelType())
		s.mu.Unlock()
		switch newCh.ChannelType() {
		case "session":
			ch, requests, accErr := newCh.Accept()
			if accErr != nil {
				continue
			}
			go s.session(ch, requests)
		case "direct-tcpip", "forwarded-tcpip", "auth-agent@openssh.com":
			_ = newCh.Reject(cryptossh.Prohibited, "forwarding denied")
		default:
			_ = newCh.Reject(cryptossh.UnknownChannelType, "unsupported")
		}
	}
}

func (s *FakeServer) session(ch cryptossh.Channel, requests <-chan *cryptossh.Request) {
	defer ch.Close()
	for req := range requests {
		s.mu.Lock()
		s.requestTypes = append(s.requestTypes, req.Type)
		s.mu.Unlock()
		switch req.Type {
		case "exec":
			cmd := parseExecPayload(req.Payload)
			s.mu.Lock()
			s.commands = append(s.commands, cmd)
			delay := s.Delay
			stdout := s.Stdout
			status := s.ExitStatus
			hook := s.OnExec
			s.mu.Unlock()
			if hook != nil {
				stdout, status = hook(cmd)
			}
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			if delay > 0 {
				time.Sleep(delay)
			}
			_, _ = ch.Write([]byte(stdout))
			var buf [4]byte
			binary.BigEndian.PutUint32(buf[:], status)
			_, _ = ch.SendRequest("exit-status", false, buf[:])
			return
		case "shell", "pty-req", "auth-agent-req@openssh.com", "x11-req", "tcpip-forward":
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

func parseExecPayload(payload []byte) string {
	if len(payload) < 4 {
		return string(payload)
	}
	n := binary.BigEndian.Uint32(payload[:4])
	if int(n) > len(payload)-4 {
		return string(payload[4:])
	}
	return string(payload[4 : 4+n])
}

func (s *FakeServer) recordAuth(method string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authMethods = append(s.authMethods, method)
}

// ResetRecords clears recorded auth/channel/command observations.
func (s *FakeServer) ResetRecords() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authMethods = nil
	s.passwords = nil
	s.channelTypes = nil
	s.requestTypes = nil
	s.commands = nil
	s.acceptedPubkey = false
}

// Close stops the listener.
func (s *FakeServer) Close() error {
	if s == nil || s.listener == nil {
		return nil
	}
	return s.listener.Close()
}

// AuthMethods is the recorded client auth attempts.
func (s *FakeServer) AuthMethods() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.authMethods...)
}

// ChannelTypes is the recorded channel types requested by the client.
func (s *FakeServer) ChannelTypes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.channelTypes...)
}

// RequestTypes is the recorded session request types.
func (s *FakeServer) RequestTypes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.requestTypes...)
}

// Commands is the recorded exec payloads.
func (s *FakeServer) Commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

// AcceptedPublicKey reports whether key auth succeeded.
func (s *FakeServer) AcceptedPublicKey() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.acceptedPubkey
}

// Passwords is any password material the client offered.
func (s *FakeServer) Passwords() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.passwords...)
}

// DialIP is the IPv4 loopback the server bound.
func (s *FakeServer) DialIP() string {
	host, _, _ := net.SplitHostPort(s.Addr)
	return host
}

// Port is the listening port.
func (s *FakeServer) Port() int {
	_, port, _ := net.SplitHostPort(s.Addr)
	n, _ := strconv.Atoi(port)
	return n
}
