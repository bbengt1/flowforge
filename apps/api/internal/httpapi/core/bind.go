package core

import "net/http"

// Bind adapts a domain handler to http.HandlerFunc.
// A nil server uses an empty Server so registration matches Routes(nil).
func Bind(s *Server, fn func(*Server, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	if s == nil {
		s = &Server{}
	}
	return func(w http.ResponseWriter, r *http.Request) {
		fn(s, w, r)
	}
}
