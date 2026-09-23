package oidc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	discoveryTTL = 5 * time.Minute
	httpTimeout  = 10 * time.Second
	maxDocBytes  = 1 << 20
	verifierAAD  = "oidc-verifier"
)

// Identity is the IdP subject minted into a FlowForge user.
// Tokens are not retained.
type Identity struct {
	Issuer      string
	Subject     string
	DisplayName string
}

// StartResult is what chrome may see. It does not include the PKCE
// verifier or the client secret.
type StartResult struct {
	AuthorizationURL string
	State            string
	ExpiresAt        time.Time
}

// Client performs discovery, PKCE start, and code exchange.
type Client struct {
	settings Settings
	store    Store
	http     *http.Client
	now      func() time.Time

	mu        sync.Mutex
	cached    discoveryDoc
	cachedTil time.Time
}

type discoveryDoc struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	JWKSURI               string   `json:"jwks_uri"`
	ChallengeMethods      []string `json:"code_challenge_methods_supported"`
	SigningAlgs           []string `json:"id_token_signing_alg_values_supported"`
}

// TransactionStore returns the PKCE transaction backend. Production boot
// refuses an in-memory store. A nil client or store is process-local.
func (c *Client) TransactionStore() Store {
	if c == nil {
		return nil
	}
	return c.store
}

// NewClient returns a client. Start and Complete fail closed until
// settings and a store are both ready.
func NewClient(s Settings, store Store) *Client {
	httpc := s.HTTP
	if httpc == nil {
		httpc = &http.Client{
			Timeout: httpTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{
		settings: s,
		store:    store,
		http:     httpc,
		now:      time.Now,
	}
}

// Ready reports whether this client can start a flow.
func (c *Client) Ready() bool {
	return c != nil && c.settings.Ready() && c.store != nil
}

// Start creates a one-time PKCE transaction and the authorize URL.
func (c *Client) Start(ctx context.Context) (StartResult, error) {
	if !c.Ready() {
		return StartResult{}, ErrNotConfigured
	}
	doc, err := c.discovery(ctx)
	if err != nil {
		return StartResult{}, err
	}
	verifier, err := newVerifier()
	if err != nil {
		return StartResult{}, ErrUnavailable
	}
	defer clearBytes([]byte(verifier))
	state, err := newState()
	if err != nil {
		return StartResult{}, ErrUnavailable
	}
	nonce, err := newNonce()
	if err != nil {
		return StartResult{}, ErrUnavailable
	}
	challenge := S256Challenge(verifier)
	blob, err := seal(c.settings.StateKey, []byte(verifier), []byte(verifierAAD))
	if err != nil {
		return StartResult{}, ErrUnavailable
	}
	id, err := newUUID()
	if err != nil {
		return StartResult{}, ErrUnavailable
	}
	now := c.now().UTC()
	exp := now.Add(txnTTL)
	if err := c.store.Put(ctx, Tx{
		ID:           id,
		StateHash:    hashState(state),
		VerifierBlob: blob,
		Nonce:        nonce,
		ExpiresAt:    exp,
	}); err != nil {
		return StartResult{}, ErrUnavailable
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", c.settings.ClientID)
	q.Set("redirect_uri", c.settings.RedirectURI)
	q.Set("scope", c.settings.Scopes)
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	return StartResult{
		AuthorizationURL: doc.AuthorizationEndpoint + "?" + q.Encode(),
		State:            state,
		ExpiresAt:        exp,
	}, nil
}

// Complete exchanges an authorization code and returns the IdP subject.
// The state is consumed even when the provider later rejects the code.
func (c *Client) Complete(ctx context.Context, code, state string) (Identity, error) {
	if !c.Ready() {
		return Identity{}, ErrNotConfigured
	}
	code = strings.TrimSpace(code)
	state = strings.TrimSpace(state)
	if code == "" || len(code) > 2048 || state == "" || len(state) > 256 || hasControl(code) || hasControl(state) {
		return Identity{}, ErrRejected
	}
	tx, err := c.store.Consume(ctx, hashState(state), c.now())
	if err != nil {
		return Identity{}, ErrRejected
	}
	verifier, err := open(c.settings.StateKey, tx.VerifierBlob, []byte(verifierAAD))
	if err != nil {
		return Identity{}, ErrRejected
	}
	defer clearBytes(verifier)
	doc, err := c.discovery(ctx)
	if err != nil {
		return Identity{}, err
	}
	rawToken, err := c.exchange(ctx, doc.TokenEndpoint, code, string(verifier))
	if err != nil {
		return Identity{}, err
	}
	keys, err := c.jwks(ctx, doc.JWKSURI)
	if err != nil {
		return Identity{}, err
	}
	claims, err := verifyIDToken(rawToken, c.settings.Issuer, c.settings.ClientID, tx.Nonce, keys, c.now())
	if err != nil {
		return Identity{}, ErrRejected
	}
	return Identity{
		Issuer:      claims.Issuer,
		Subject:     claims.Subject,
		DisplayName: displayFromClaims(claims),
	}, nil
}

func (c *Client) discovery(ctx context.Context) (discoveryDoc, error) {
	now := c.now()
	c.mu.Lock()
	if c.cached.Issuer != "" && now.Before(c.cachedTil) {
		doc := c.cached
		c.mu.Unlock()
		return doc, nil
	}
	c.mu.Unlock()
	endpoint := strings.TrimRight(c.settings.Issuer, "/") + "/.well-known/openid-configuration"
	var doc discoveryDoc
	if err := c.getJSON(ctx, endpoint, &doc); err != nil {
		return discoveryDoc{}, err
	}
	if doc.Issuer != c.settings.Issuer {
		return discoveryDoc{}, ErrUnavailable
	}
	if err := c.allowEndpoint(doc.AuthorizationEndpoint); err != nil {
		return discoveryDoc{}, err
	}
	if err := c.allowEndpoint(doc.TokenEndpoint); err != nil {
		return discoveryDoc{}, err
	}
	if err := c.allowEndpoint(doc.JWKSURI); err != nil {
		return discoveryDoc{}, err
	}
	if !contains(doc.ChallengeMethods, "S256") || !contains(doc.SigningAlgs, "RS256") {
		return discoveryDoc{}, ErrUnavailable
	}
	c.mu.Lock()
	c.cached = doc
	c.cachedTil = now.Add(discoveryTTL)
	c.mu.Unlock()
	return doc, nil
}

func (c *Client) exchange(ctx context.Context, tokenEndpoint, code, verifier string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", c.settings.RedirectURI)
	form.Set("client_id", c.settings.ClientID)
	form.Set("client_secret", c.settings.ClientSecret)
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", ErrUnavailable
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", ErrUnavailable
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDocBytes))
	if err != nil {
		return "", ErrUnavailable
	}
	var parsed struct {
		IDToken string `json:"id_token"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", ErrRejected
	}
	if resp.StatusCode != http.StatusOK || parsed.Error != "" || parsed.IDToken == "" {
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized || parsed.Error != "" {
			return "", ErrRejected
		}
		return "", ErrUnavailable
	}
	return parsed.IDToken, nil
}

func (c *Client) jwks(ctx context.Context, jwksURI string) ([]jwk, error) {
	var set jwkSet
	if err := c.getJSON(ctx, jwksURI, &set); err != nil {
		return nil, err
	}
	if len(set.Keys) == 0 {
		return nil, ErrUnavailable
	}
	return set.Keys, nil
}

func (c *Client) getJSON(ctx context.Context, endpoint string, dest any) error {
	if err := c.allowEndpoint(endpoint); err != nil && !strings.HasSuffix(endpoint, "/.well-known/openid-configuration") {
		return err
	}
	if strings.HasSuffix(endpoint, "/.well-known/openid-configuration") {
		if err := c.allowEndpoint(c.settings.Issuer + "/.well-known/openid-configuration"); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ErrUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDocBytes))
	if err != nil {
		return ErrUnavailable
	}
	if err := json.Unmarshal(body, dest); err != nil {
		return ErrUnavailable
	}
	return nil
}

func (c *Client) allowEndpoint(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return ErrUnavailable
	}
	iss, err := url.Parse(c.settings.Issuer)
	if err != nil || iss.Host == "" {
		return ErrUnavailable
	}
	if iss.Scheme == "https" {
		if u.Scheme != "https" {
			return ErrUnavailable
		}
		return nil
	}
	if u.Scheme != "http" || !strings.EqualFold(u.Host, iss.Host) {
		return ErrUnavailable
	}
	return nil
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func clearBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
