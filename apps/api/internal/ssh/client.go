package ssh

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	cryptossh "golang.org/x/crypto/ssh"
)

// Session is one non-interactive remote command.
type Session interface {
	Run(ctx context.Context, command string) (stdout, stderr string, exitCode int, err error)
	Close() error
}

// Transport opens an isolated SSH session. Implementations must dial only
// ConnectConfig.NetworkAddress (never the original hostname).
type Transport interface {
	Connect(ctx context.Context, cfg ConnectConfig) (Session, error)
}

// ConnectConfig is the closed, fail-closed SSH client contract.
type ConnectConfig struct {
	NetworkAddress string
	Username       string
	Signer         cryptossh.Signer
	HostKeySHA256  string
	Timeout        time.Duration

	// The following flags are hard-denied. Any true value fails closed.
	AllowPassword       bool
	AgentForwarding     bool
	PortForwarding      bool
	ProxyCommand        bool
	AutoAcceptHostKey   bool
	InteractiveShell    bool
	KeyboardInteractive bool
}

// IsolatedClientConfig builds the only allowed golang.org/x/crypto/ssh config.
func IsolatedClientConfig(cfg ConnectConfig) (*cryptossh.ClientConfig, *EngineError) {
	if err := denyUnsafeConnect(cfg); err != nil {
		return nil, err
	}
	if cfg.Signer == nil {
		return nil, engineError(CodeHandleForbidden, "key-only auth requires an ephemeral signer", http.StatusForbidden)
	}
	if strings.TrimSpace(cfg.Username) == "" {
		return nil, engineError(CodeInvalidTarget, "remote username is required", http.StatusBadRequest)
	}
	if isDeniedUsername(cfg.Username) {
		return nil, engineError(CodeRootDenied, "remote account must not be root", http.StatusForbidden)
	}
	want, err := NormalizeFingerprint(cfg.HostKeySHA256)
	if err != nil {
		return nil, engineError(CodeInvalidFingerprint, "hostKeyFingerprint is not sha256:<hex> or SHA256:<base64>.", http.StatusBadRequest)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultConnectTimeout
	}
	return &cryptossh.ClientConfig{
		User: cfg.Username,
		Auth: []cryptossh.AuthMethod{cryptossh.PublicKeys(cfg.Signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key cryptossh.PublicKey) error {
			got := PublicKeyFingerprint(key)
			if got != want {
				return engineError(CodeHostKeyMismatch, "known-host fingerprint mismatch", http.StatusForbidden)
			}
			return nil
		},
		Timeout: timeout,
		HostKeyAlgorithms: []string{
			cryptossh.KeyAlgoED25519,
			cryptossh.KeyAlgoECDSA256,
			cryptossh.KeyAlgoECDSA384,
			cryptossh.KeyAlgoECDSA521,
			cryptossh.KeyAlgoRSA,
			cryptossh.KeyAlgoRSASHA256,
			cryptossh.KeyAlgoRSASHA512,
		},
	}, nil
}

func denyUnsafeConnect(cfg ConnectConfig) *EngineError {
	switch {
	case cfg.AllowPassword, cfg.KeyboardInteractive:
		return engineError(CodeAuthDenied, "password and keyboard-interactive authentication are disabled", http.StatusForbidden)
	case cfg.AgentForwarding:
		return engineError(CodeForwardingDenied, "agent forwarding is disabled", http.StatusForbidden)
	case cfg.PortForwarding:
		return engineError(CodeForwardingDenied, "port forwarding is disabled", http.StatusForbidden)
	case cfg.ProxyCommand:
		return engineError(CodeForwardingDenied, "proxy commands are disabled", http.StatusForbidden)
	case cfg.AutoAcceptHostKey:
		return engineError(CodeHostKeyMismatch, "host-key auto-accept is disabled", http.StatusForbidden)
	case cfg.InteractiveShell:
		return engineError(CodeForwardingDenied, "interactive shells are disabled", http.StatusForbidden)
	}
	if strings.TrimSpace(cfg.NetworkAddress) == "" {
		return engineError(CodeAddressDenied, "connection must target a verified address", http.StatusForbidden)
	}
	host, _, err := net.SplitHostPort(cfg.NetworkAddress)
	if err != nil || net.ParseIP(host) == nil {
		return engineError(CodeAddressDenied, "connection must dial a verified IP address, not a hostname", http.StatusForbidden)
	}
	return nil
}

// PublicKeyFingerprint is the canonical sha256:<hex> of an SSH public key.
func PublicKeyFingerprint(key cryptossh.PublicKey) string {
	if key == nil {
		return ""
	}
	sum := sha256.Sum256(key.Marshal())
	return "sha256:" + hex.EncodeToString(sum[:])
}

// LiveTransport dials TCP to the verified address and opens a command session.
type LiveTransport struct {
	Dialer *net.Dialer
}

// Connect implements Transport.
func (t LiveTransport) Connect(ctx context.Context, cfg ConnectConfig) (Session, error) {
	clientCfg, err := IsolatedClientConfig(cfg)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	dialer := t.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: clientCfg.Timeout}
	}
	conn, dialErr := dialer.DialContext(ctx, "tcp", cfg.NetworkAddress)
	if dialErr != nil {
		if ctx.Err() != nil {
			return nil, mapContextError(ctx.Err())
		}
		if isTimeoutError(dialErr) {
			return nil, engineError(CodeTimeout, "SSH connection or command exceeded timeoutSeconds", http.StatusRequestTimeout)
		}
		return nil, engineError(CodeConnectFailed, "SSH connection failed", http.StatusBadGateway)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	c, chans, reqs, sshErr := cryptossh.NewClientConn(conn, cfg.NetworkAddress, clientCfg)
	if sshErr != nil {
		_ = conn.Close()
		if isHostKeyErr(sshErr) {
			return nil, asEngineError(sshErr, CodeHostKeyMismatch)
		}
		if ctx.Err() != nil {
			return nil, mapContextError(ctx.Err())
		}
		if isTimeoutError(sshErr) {
			return nil, engineError(CodeTimeout, "SSH connection or command exceeded timeoutSeconds", http.StatusRequestTimeout)
		}
		return nil, engineError(CodeConnectFailed, "SSH handshake failed", http.StatusBadGateway)
	}
	client := cryptossh.NewClient(c, chans, reqs)
	return &liveSession{client: client, conn: conn}, nil
}

type liveSession struct {
	client *cryptossh.Client
	conn   net.Conn
}

func (s *liveSession) Run(ctx context.Context, command string) (string, string, int, error) {
	if s == nil || s.client == nil {
		return "", "", -1, engineError(CodeConnectFailed, "SSH session is not open", http.StatusBadGateway)
	}
	if strings.TrimSpace(command) == "" {
		return "", "", -1, engineError(CodeInvalidTemplate, "rendered command is empty", http.StatusBadRequest)
	}
	sess, err := s.client.NewSession()
	if err != nil {
		return "", "", -1, engineError(CodeConnectFailed, "SSH session could not be opened", http.StatusBadGateway)
	}
	defer sess.Close()

	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- sess.Run(command)
	}()

	select {
	case <-ctx.Done():
		_ = sess.Close()
		return "", "", -1, mapContextError(ctx.Err())
	case runErr := <-done:
		if ctx.Err() != nil {
			return "", "", -1, mapContextError(ctx.Err())
		}
		code := 0
		if runErr != nil {
			var exitErr *cryptossh.ExitError
			if errors.As(runErr, &exitErr) {
				code = exitErr.ExitStatus()
			} else if isTimeoutError(runErr) {
				return stdout.String(), stderr.String(), -1, engineError(CodeTimeout, "SSH connection or command exceeded timeoutSeconds", http.StatusRequestTimeout)
			} else {
				return stdout.String(), stderr.String(), -1, engineError(CodeCommandFailed, "remote command failed", http.StatusBadGateway)
			}
		}
		return stdout.String(), stderr.String(), code, nil
	}
}

func (s *liveSession) Close() error {
	if s == nil {
		return nil
	}
	if s.client != nil {
		_ = s.client.Close()
	}
	if s.conn != nil {
		return s.conn.Close()
	}
	return nil
}

func mapContextError(err error) *EngineError {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return engineError(CodeCanceled, "SSH operation was canceled", http.StatusRequestTimeout)
	}
	return engineError(CodeTimeout, "SSH connection or command exceeded timeoutSeconds", http.StatusRequestTimeout)
}

func isHostKeyErr(err error) bool {
	if err == nil {
		return false
	}
	var ee *EngineError
	if errors.As(err, &ee) && ee != nil && ee.Code == CodeHostKeyMismatch {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "fingerprint") || strings.Contains(msg, "host key")
}
