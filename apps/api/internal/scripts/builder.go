package scripts

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"golang.org/x/crypto/sha3"
)

// SignedBinary is a Go artifact produced by the controlled builder.
// CI uses a documented stub that still signs the published source digest
// and runs every isolation gate. A live builder compiles the same source
// in the approved image (deploy/kubernetes/script-runner-deployment.yaml).
type SignedBinary struct {
	Digest       string `json:"digest"`
	Signature    string `json:"signature"`
	Language     string `json:"language"`
	Entrypoint   string `json:"entrypoint"`
	SourceDigest string `json:"sourceDigest"`
	Stub         bool   `json:"stub"`
}

// ControlledBuilder turns published Go source into a signed binary.
type ControlledBuilder interface {
	Build(ctx context.Context, art Artifact, source, entrypoint string, key []byte) (SignedBinary, error)
}

// StubBuilder is the CI/default builder. It does not invoke `go build`.
// The signature binds the published artifact digest so a mutated source
// cannot produce a verifiable binary.
type StubBuilder struct{}

// Build signs the published source. Isolation is enforced by Execute, not here.
func (StubBuilder) Build(_ context.Context, art Artifact, source, entrypoint string, key []byte) (SignedBinary, error) {
	return SignGoBinary(key, art, source, entrypoint)
}

// SignGoBinary HMACs the published digest + source under a Go-binary domain.
func SignGoBinary(key []byte, art Artifact, source, entrypoint string) (SignedBinary, error) {
	if strings.TrimSpace(art.Digest) == "" || !digestRE.MatchString(art.Digest) {
		return SignedBinary{}, ErrInvalid
	}
	if err := ValidateSource(LanguageGo, source, entrypoint); err != nil {
		return SignedBinary{}, err
	}
	if len(key) < 16 {
		return SignedBinary{}, ErrSigningKey
	}
	mac := hmac.New(sha256.New, deriveGoBinaryKey(key))
	_, _ = mac.Write([]byte(art.Digest))
	_, _ = mac.Write([]byte{'\n'})
	_, _ = mac.Write([]byte(source))
	sum := mac.Sum(nil)
	srcSum := sha256.Sum256([]byte(source))
	return SignedBinary{
		Digest:       "sha256:" + hex.EncodeToString(sum),
		Signature:    GoBinaryPrefix + hex.EncodeToString(sum),
		Language:     LanguageGo,
		Entrypoint:   strings.TrimSpace(entrypoint),
		SourceDigest: "sha256:" + hex.EncodeToString(srcSum[:]),
		Stub:         true,
	}, nil
}

// VerifyGoBinary reports whether the stub signature matches published source.
func VerifyGoBinary(key []byte, art Artifact, source, entrypoint string, bin SignedBinary) bool {
	want, err := SignGoBinary(key, art, source, entrypoint)
	if err != nil {
		return false
	}
	return hmac.Equal([]byte(want.Signature), []byte(strings.TrimSpace(bin.Signature))) &&
		hmac.Equal([]byte(want.Digest), []byte(strings.TrimSpace(bin.Digest)))
}

func deriveGoBinaryKey(key []byte) []byte {
	sum := sha3.Sum256(append([]byte("flowforge-script-go-binary-v1\n"), key...))
	return sum[:]
}
