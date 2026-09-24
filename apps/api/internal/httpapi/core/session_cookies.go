package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

// cookieFlags are Set-Cookie attributes for one session cookie.
// Embed (CHIPS) sessions use SameSite=None; Secure; Partitioned so
// the pair works in a cross-site iframe. SameSite=None is never
// emitted without Partitioned, and Secure is never dropped on the
// embed path. First-party sessions stay Lax / Strict. Their Secure
// bit is the caller's decision: HTTPS, REQUIRE_TLS, or production-locked.
type cookieFlags struct {
	SameSite    http.SameSite
	Secure      bool
	Partitioned bool
}

func sessionCookieFlags(secure, chips bool) cookieFlags {
	if chips {
		return cookieFlags{
			SameSite:    http.SameSiteNoneMode,
			Secure:      true,
			Partitioned: true,
		}
	}
	return cookieFlags{
		SameSite:    http.SameSiteLaxMode,
		Secure:      secure,
		Partitioned: false,
	}
}

func csrfCookieFlags(secure, chips bool) cookieFlags {
	if chips {
		return cookieFlags{
			SameSite:    http.SameSiteNoneMode,
			Secure:      true,
			Partitioned: true,
		}
	}
	return cookieFlags{
		SameSite:    http.SameSiteStrictMode,
		Secure:      secure,
		Partitioned: false,
	}
}

// RequestCookieSecure reports whether a first-party browser cookie must
// be marked Secure. HTTPS requests, REQUIRE_TLS, and a production-locked
// process are fail-closed. Explicit local/dev/test over cleartext HTTP
// is not, so Login can bootstrap without TLS. CHIPS cookies ignore this
// and stay Secure.
func RequestCookieSecure(sec Security, r *http.Request) bool {
	if r != nil && sec.RequestIsHTTPS(r) {
		return true
	}
	return sec.RequireTLS || sec.ProductionLocked
}

// WriteCookie adds one HttpOnly Set-Cookie header.
//
// Session and OIDC state cookies use this writer. The CSRF cookie uses
// writeReadableCookie so it stays readable for double-submit. The two
// writers do not share a Set-Cookie call.
//
// When secure is set, the cookie is passed to http.SetCookie with Secure
// and HttpOnly set to true. Non-production cleartext HTTP omits Secure and
// does not call http.SetCookie. The serializer is Cookie.String, which
// SetCookie uses, so the wire format matches. Local Login can still store
// the cookie over HTTP. Embed (CHIPS) callers pass secure=true.
func WriteCookie(w http.ResponseWriter, c http.Cookie, secure bool) {
	if secure {
		secured := c
		secured.Secure = true
		secured.HttpOnly = true
		http.SetCookie(w, &secured)
		return
	}
	emitCleartextCookie(w, http.Cookie{
		Name:        c.Name,
		Value:       c.Value,
		Path:        c.Path,
		Domain:      c.Domain,
		Expires:     c.Expires,
		MaxAge:      c.MaxAge,
		HttpOnly:    true,
		SameSite:    c.SameSite,
		Partitioned: c.Partitioned,
	})
}

// writeReadableCookie adds one Set-Cookie header that JavaScript can read.
// ff_csrf is the only caller. HttpOnly stays false.
func writeReadableCookie(w http.ResponseWriter, c http.Cookie, secure bool) {
	if secure {
		readable := c
		readable.Secure = true
		readable.HttpOnly = false
		http.SetCookie(w, &readable)
		return
	}
	emitCleartextCookie(w, http.Cookie{
		Name:        c.Name,
		Value:       c.Value,
		Path:        c.Path,
		Domain:      c.Domain,
		Expires:     c.Expires,
		MaxAge:      c.MaxAge,
		HttpOnly:    false,
		SameSite:    c.SameSite,
		Partitioned: c.Partitioned,
	})
}

func emitCleartextCookie(w http.ResponseWriter, c http.Cookie) {
	if v := c.String(); v != "" {
		w.Header().Add("Set-Cookie", v)
	}
}

func writeSessionCookiePair(w http.ResponseWriter, token, csrf string, maxAge int, secure, chips bool) {
	sessionFlags := sessionCookieFlags(secure, chips)
	csrfFlags := csrfCookieFlags(secure, chips)
	WriteCookie(w, http.Cookie{
		Name:        session.CookieName,
		Value:       token,
		Path:        session.CookiePath,
		HttpOnly:    true,
		SameSite:    sessionFlags.SameSite,
		Partitioned: sessionFlags.Partitioned,
		MaxAge:      maxAge,
	}, sessionFlags.Secure)
	writeReadableCookie(w, http.Cookie{
		Name:        session.CSRFCookieName,
		Value:       csrf,
		Path:        session.CookiePath,
		HttpOnly:    false,
		SameSite:    csrfFlags.SameSite,
		Partitioned: csrfFlags.Partitioned,
		MaxAge:      maxAge,
	}, csrfFlags.Secure)
}
