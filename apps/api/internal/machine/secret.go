package machine

import (
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

const (
	minSecretLength = 16
	maxSecretLength = 72
)

var dummyHash []byte

func init() {
	hash, err := bcrypt.GenerateFromPassword([]byte("flowforge-machine-dummy"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	dummyHash = hash
}

// ValidateSecret checks length only. It never returns the secret.
func ValidateSecret(secret string) error {
	if len(secret) < minSecretLength || len(secret) > maxSecretLength {
		return ErrInvalid
	}
	for _, r := range secret {
		if unicode.IsControl(r) {
			return ErrInvalid
		}
	}
	return nil
}

// HashSecret returns a bcrypt hash. The secret is not retained.
func HashSecret(secret string) (string, error) {
	if err := ValidateSecret(secret); err != nil {
		return "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifySecret compares secret to a stored bcrypt hash.
func VerifySecret(secret, hash string) bool {
	if hash == "" {
		DummyVerify(secret)
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(secret)) == nil
}

// DummyVerify spends a bcrypt compare so a missing principal does not
// return faster than a wrong secret.
func DummyVerify(secret string) {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(secret))
}
