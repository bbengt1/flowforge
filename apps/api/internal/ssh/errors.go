package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

// EngineError is a secret-free failure returned to jobs and tests.
type EngineError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"status,omitempty"`
	Path    string `json:"path,omitempty"`
}

func (e *EngineError) Error() string {
	if e == nil {
		return ""
	}
	if e.Path != "" {
		return fmt.Sprintf("%s: %s", e.Path, e.Message)
	}
	return e.Message
}

func engineError(code, message string, status int) *EngineError {
	return &EngineError{Code: code, Message: message, Status: status}
}

func asEngineError(err error, fallback string) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if errors.As(err, &ee) {
		return ee
	}
	if errors.Is(err, context.Canceled) {
		return engineError(CodeCanceled, "SSH operation was canceled", http.StatusRequestTimeout)
	}
	if isTimeoutError(err) {
		return engineError(CodeTimeout, "SSH connection or command exceeded timeoutSeconds", http.StatusRequestTimeout)
	}
	if errors.Is(err, ErrInvalid) {
		return engineError(CodeInvalidTarget, err.Error(), http.StatusBadRequest)
	}
	return engineError(fallback, "SSH operation failed.", http.StatusBadGateway)
}

// isTimeoutError reports whether err is a context, socket, or SSH I/O deadline.
// sess.Run can lose the race with ctx.Done() and return os.ErrDeadlineExceeded
// from conn.SetDeadline before the context error is observed.
func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne != nil && ne.Timeout() {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "deadline exceeded")
}

func mapRenderError(err error) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if errors.As(err, &ee) {
		return ee
	}
	msg := err.Error()
	switch {
	case containsFoldToken(msg, "interpolation"):
		return engineError(CodeInterpolationDenied, "Template or values attempted raw shell interpolation.", http.StatusBadRequest)
	case containsFoldToken(msg, "parameter"):
		return engineError(CodeParameterRejected, "A parameter is missing, extra, or outside schema constraints.", http.StatusBadRequest)
	case containsFoldToken(msg, "template"):
		return engineError(CodeInvalidTemplate, "Command profile template is not a reviewed profile.", http.StatusBadRequest)
	case containsFoldToken(msg, "schema"):
		return engineError(CodeInvalidSchema, "Command profile parameterSchema is invalid.", http.StatusBadRequest)
	default:
		return engineError(CodeParameterRejected, "Command profile rendering failed.", http.StatusBadRequest)
	}
}

func containsFoldToken(s, token string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(token))
}
