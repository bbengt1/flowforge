package wfstore

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// EnvJobBindingSecret is the HMAC key for authenticated job tickets.
	// Value is standard/raw-URL base64 or 64 hex characters (32 bytes).
	EnvJobBindingSecret = "JOB_BINDING_SECRET"
	jobTicketVersion    = "v1"
	jobTicketVersionV2  = "v2"
)

// NewJobBindingKey returns a random 32-byte HMAC key. Used when the
// process environment does not set JOB_BINDING_SECRET (local/tests).
func NewJobBindingKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		sum := sha256.Sum256([]byte("flowforge-ephemeral-job-binding"))
		return sum[:]
	}
	return key
}

// LoadJobBindingKey reads JOB_BINDING_SECRET or generates an ephemeral key.
func LoadJobBindingKey() []byte {
	raw := strings.TrimSpace(os.Getenv(EnvJobBindingSecret))
	if raw == "" {
		return NewJobBindingKey()
	}
	if key, err := parseJobBindingKey(raw); err == nil {
		return key
	}
	return NewJobBindingKey()
}

func parseJobBindingKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("%s is empty", EnvJobBindingSecret)
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if len(raw) == 32 {
		return []byte(raw), nil
	}
	return nil, fmt.Errorf("%s must be 32 bytes (base64 or 64 hex)", EnvJobBindingSecret)
}

// SignJobTicket returns an HMAC-authenticated ticket for a claimed job.
func SignJobTicket(key []byte, b JobBinding) (string, error) {
	if len(key) < 16 {
		return "", ErrInvalid
	}
	payload := encodeTicketPayload(b)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// ParseJobTicket verifies HMAC and reconstructs the binding. Altered tokens fail closed.
func ParseJobTicket(key []byte, token string) (JobBinding, error) {
	token = strings.TrimSpace(token)
	payloadB64, sigB64, ok := strings.Cut(token, ".")
	if !ok || payloadB64 == "" || sigB64 == "" || len(key) < 16 {
		return JobBinding{}, ErrJobBinding
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return JobBinding{}, ErrJobBinding
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return JobBinding{}, ErrJobBinding
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return JobBinding{}, ErrJobBinding
	}
	return decodeTicketPayload(string(payload))
}

func encodeTicketPayload(b JobBinding) string {
	if strings.TrimSpace(b.TenantID) != "" || strings.TrimSpace(b.WorkbenchKey) != "" {
		return strings.Join([]string{
			jobTicketVersionV2,
			b.WorkspaceID,
			b.TenantID,
			b.WorkbenchKey,
			b.ExecutionID,
			b.JobID,
			b.StepID,
			b.WorkflowID,
			b.WorkflowVersionID,
			b.WorkflowDigest,
			b.PolicyDigest,
			strconv.FormatInt(b.FencingToken, 10),
			b.ExpiresAt.UTC().Format(time.RFC3339Nano),
			b.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
			b.CorrelationID,
		}, "\n")
	}
	return strings.Join([]string{
		jobTicketVersion,
		b.WorkspaceID,
		b.ExecutionID,
		b.JobID,
		b.StepID,
		b.WorkflowID,
		b.WorkflowVersionID,
		b.WorkflowDigest,
		b.PolicyDigest,
		strconv.FormatInt(b.FencingToken, 10),
		b.ExpiresAt.UTC().Format(time.RFC3339Nano),
		b.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		b.CorrelationID,
	}, "\n")
}

func decodeTicketPayload(payload string) (JobBinding, error) {
	parts := strings.Split(payload, "\n")
	switch {
	case len(parts) == 15 && parts[0] == jobTicketVersionV2:
		token, err := strconv.ParseInt(parts[11], 10, 64)
		if err != nil || token < 1 {
			return JobBinding{}, ErrJobBinding
		}
		expires, err := time.Parse(time.RFC3339Nano, parts[12])
		if err != nil {
			return JobBinding{}, ErrJobBinding
		}
		lease, err := time.Parse(time.RFC3339Nano, parts[13])
		if err != nil {
			return JobBinding{}, ErrJobBinding
		}
		return JobBinding{
			WorkspaceID:       parts[1],
			TenantID:          parts[2],
			WorkbenchKey:      parts[3],
			ExecutionID:       parts[4],
			JobID:             parts[5],
			StepID:            parts[6],
			WorkflowID:        parts[7],
			WorkflowVersionID: parts[8],
			WorkflowDigest:    parts[9],
			PolicyDigest:      parts[10],
			FencingToken:      token,
			ExpiresAt:         expires,
			LeaseExpiresAt:    lease,
			CorrelationID:     parts[14],
		}, nil
	case len(parts) == 13 && parts[0] == jobTicketVersion:
		token, err := strconv.ParseInt(parts[9], 10, 64)
		if err != nil || token < 1 {
			return JobBinding{}, ErrJobBinding
		}
		expires, err := time.Parse(time.RFC3339Nano, parts[10])
		if err != nil {
			return JobBinding{}, ErrJobBinding
		}
		lease, err := time.Parse(time.RFC3339Nano, parts[11])
		if err != nil {
			return JobBinding{}, ErrJobBinding
		}
		return JobBinding{
			WorkspaceID:       parts[1],
			ExecutionID:       parts[2],
			JobID:             parts[3],
			StepID:            parts[4],
			WorkflowID:        parts[5],
			WorkflowVersionID: parts[6],
			WorkflowDigest:    parts[7],
			PolicyDigest:      parts[8],
			FencingToken:      token,
			ExpiresAt:         expires,
			LeaseExpiresAt:    lease,
			CorrelationID:     parts[12],
		}, nil
	default:
		return JobBinding{}, ErrJobBinding
	}
}
