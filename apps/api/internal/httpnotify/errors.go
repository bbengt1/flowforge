package httpnotify

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
		return engineError(CodeCanceled, "HTTP or notification operation was canceled", http.StatusRequestTimeout)
	}
	if isTimeoutError(err) {
		return engineError(CodeTimeout, "HTTP or notification operation exceeded timeoutSeconds", http.StatusRequestTimeout)
	}
	if errors.Is(err, ErrInvalid) {
		return engineError(CodeInvalidConnection, err.Error(), http.StatusBadRequest)
	}
	return engineError(fallback, "Delivery failed.", http.StatusBadGateway)
}

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
