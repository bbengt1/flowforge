package httpapi

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

// cookieFlags are Set-Cookie attributes for one session cookie.
// Embed (CHIPS) sessions use SameSite=None; Secure; Partitioned so
// the pair works in a cross-site iframe. SameSite=None is never
// emitted without Partitioned, and Secure is never dropped on the
// embed path. First-party sessions stay Lax / Strict.
type cookieFlags struct {
	SameSite    http.SameSite
	Secure      bool
	Partitioned bool
}

func sessionCookieFlags(https, chips bool) cookieFlags {
	if chips {
		return cookieFlags{
			SameSite:    http.SameSiteNoneMode,
			Secure:      true,
			Partitioned: true,
		}
	}
	return cookieFlags{
		SameSite:    http.SameSiteLaxMode,
		Secure:      https,
		Partitioned: false,
	}
}

func csrfCookieFlags(https, chips bool) cookieFlags {
	if chips {
		return cookieFlags{
			SameSite:    http.SameSiteNoneMode,
			Secure:      true,
			Partitioned: true,
		}
	}
	return cookieFlags{
		SameSite:    http.SameSiteStrictMode,
		Secure:      https,
		Partitioned: false,
	}
}

func writeSessionCookiePair(w http.ResponseWriter, token, csrf string, maxAge int, https, chips bool) {
	sessionFlags := sessionCookieFlags(https, chips)
	csrfFlags := csrfCookieFlags(https, chips)
	http.SetCookie(w, &http.Cookie{
		Name:        session.CookieName,
		Value:       token,
		Path:        session.CookiePath,
		HttpOnly:    true,
		Secure:      sessionFlags.Secure,
		SameSite:    sessionFlags.SameSite,
		Partitioned: sessionFlags.Partitioned,
		MaxAge:      maxAge,
	})
	http.SetCookie(w, &http.Cookie{
		Name:        session.CSRFCookieName,
		Value:       csrf,
		Path:        session.CookiePath,
		HttpOnly:    false,
		Secure:      csrfFlags.Secure,
		SameSite:    csrfFlags.SameSite,
		Partitioned: csrfFlags.Partitioned,
		MaxAge:      maxAge,
	})
}
