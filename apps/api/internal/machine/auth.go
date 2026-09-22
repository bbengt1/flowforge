package machine

import (
	"crypto/ed25519"
	"time"
)

// Authenticate checks one factor. secret and assertion are mutually
// exclusive. consume records assertion jti; a nil consume on the
// assertion path fails closed.
func Authenticate(p Principal, secret, assertion string, now time.Time, consume func(jti string, until time.Time) error) error {
	if p.Status != StatusActive {
		return ErrRevoked
	}
	switch {
	case secret != "" && assertion != "":
		return ErrInvalid
	case secret != "":
		if !VerifySecret(secret, p.secretHash) {
			return ErrCredential
		}
		return nil
	case assertion != "":
		if len(p.publicKey) != ed25519.PublicKeySize {
			return ErrCredential
		}
		jti, exp, err := VerifyAssertion(p.publicKey, assertion, p.ClientID, now)
		if err != nil {
			return ErrCredential
		}
		if consume == nil {
			return ErrMisconfigured
		}
		if err := consume(jti, exp); err != nil {
			return err
		}
		return nil
	default:
		return ErrInvalid
	}
}
