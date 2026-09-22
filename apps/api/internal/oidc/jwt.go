package oidc

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"time"
)

const maxIDTokenBytes = 16 << 10

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

type idClaims struct {
	Issuer    string   `json:"iss"`
	Subject   string   `json:"sub"`
	Audience  audience `json:"aud"`
	Expiry    int64    `json:"exp"`
	Issued    int64    `json:"iat"`
	NotBefore int64    `json:"nbf"`
	Nonce     string   `json:"nonce"`
	Azp       string   `json:"azp"`
	Name      string   `json:"name"`
	Email     string   `json:"email"`
}

type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		return ErrRejected
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return ErrRejected
		}
		*a = []string{s}
		return nil
	}
	var list []string
	if err := json.Unmarshal(b, &list); err != nil {
		return ErrRejected
	}
	*a = list
	return nil
}

type jwkSet struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (k jwk) publicKey() (*rsa.PublicKey, error) {
	if k.Kty != "RSA" || k.N == "" || k.E == "" {
		return nil, ErrRejected
	}
	if k.Use != "" && k.Use != "sig" {
		return nil, ErrRejected
	}
	if k.Alg != "" && k.Alg != "RS256" {
		return nil, ErrRejected
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil || len(nBytes) < 256 {
		return nil, ErrRejected
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil || len(eBytes) == 0 || len(eBytes) > 8 {
		return nil, ErrRejected
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e < 3 {
		return nil, ErrRejected
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func verifyIDToken(raw, issuer, clientID, nonce string, keys []jwk, now time.Time) (idClaims, error) {
	if raw == "" || len(raw) > maxIDTokenBytes || strings.Count(raw, ".") != 2 {
		return idClaims{}, ErrRejected
	}
	parts := strings.Split(raw, ".")
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return idClaims{}, ErrRejected
	}
	var header jwtHeader
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		return idClaims{}, ErrRejected
	}
	if header.Alg != "RS256" {
		return idClaims{}, ErrRejected
	}
	pub, err := selectKey(keys, header.Kid)
	if err != nil {
		return idClaims{}, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return idClaims{}, ErrRejected
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return idClaims{}, ErrRejected
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return idClaims{}, ErrRejected
	}
	var claims idClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return idClaims{}, ErrRejected
	}
	if claims.Issuer != issuer || claims.Subject == "" || hasControl(claims.Subject) || len(claims.Subject) > 256 {
		return idClaims{}, ErrRejected
	}
	if !audienceContains(claims.Audience, clientID) {
		return idClaims{}, ErrRejected
	}
	if len(claims.Audience) > 1 && claims.Azp != clientID {
		return idClaims{}, ErrRejected
	}
	if claims.Azp != "" && claims.Azp != clientID {
		return idClaims{}, ErrRejected
	}
	if claims.Nonce == "" || claims.Nonce != nonce {
		return idClaims{}, ErrRejected
	}
	nowUnix := now.UTC().Unix()
	const skew = int64(60)
	if claims.Expiry == 0 || claims.Issued == 0 {
		return idClaims{}, ErrRejected
	}
	if claims.Expiry+skew < nowUnix || claims.Issued > nowUnix+skew {
		return idClaims{}, ErrRejected
	}
	if claims.NotBefore != 0 && claims.NotBefore > nowUnix+skew {
		return idClaims{}, ErrRejected
	}
	return claims, nil
}

func selectKey(keys []jwk, kid string) (*rsa.PublicKey, error) {
	var matched []jwk
	for _, k := range keys {
		if k.Use != "" && k.Use != "sig" {
			continue
		}
		if k.Alg != "" && k.Alg != "RS256" {
			continue
		}
		if kid != "" && k.Kid != kid {
			continue
		}
		matched = append(matched, k)
	}
	if kid == "" && len(matched) != 1 {
		return nil, ErrRejected
	}
	if len(matched) == 0 {
		return nil, ErrRejected
	}
	return matched[0].publicKey()
}

func audienceContains(aud []string, clientID string) bool {
	for _, item := range aud {
		if item == clientID {
			return true
		}
	}
	return false
}

func displayFromClaims(c idClaims) string {
	for _, raw := range []string{c.Name, c.Email, c.Subject} {
		s := strings.TrimSpace(raw)
		if s == "" || len(s) > 200 || hasControl(s) {
			continue
		}
		return s
	}
	return "operator"
}
