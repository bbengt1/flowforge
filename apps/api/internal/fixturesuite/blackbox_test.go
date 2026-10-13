package fixturesuite

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// Black-box mode (#673). FIXTURESUITE_API_URL=<base URL> sends every
// suite request, and the compose worker's traffic, to a running API
// container (built from apps/api/Dockerfile) instead of the in-process
// handler. Seeding and audit reads still use TEST_DATABASE_URL, which
// must be the container's database. The container must trust identity
// headers (development compose defaults) and list
// testIssuer|blackboxRootSubject in PLATFORM_ADMINS.
//
// Only compose-driver parts that need no suite clock run here: the
// container keeps its own real clock and recover sweep, so the runner
// driver and any part that moves the clock, kills a worker, or calls
// TickRecover is skipped with its reason.
const blackboxRootSubject = "fixturesuite-blackbox"

func blackboxURL() string { return strings.TrimSpace(os.Getenv("FIXTURESUITE_API_URL")) }

// blackboxHandler proxies to the container at raw.
func blackboxHandler(raw string) (http.Handler, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	return httputil.NewSingleHostReverseProxy(u), nil
}

// blackboxClockFixtures need the suite's fake clock, the recover sweep,
// or a killed worker (approval expiry and lease loss included).
var blackboxClockFixtures = map[string]string{
	"09-wait-resume": "wait/resume needs advance-clock and a killed runner",
	"10-timeout":     "approval expiry needs set-now and tick-recover",
	"13-lease-loss":  "lease loss needs a killed worker and the clock moved past the lease",
}

// blackboxSkip returns why a part cannot run against the container, or "".
func blackboxSkip(fx Fixture, p Part) string {
	if p.Driver != "compose" {
		return "black-box: only the compose worker runs against the container; the " + p.Driver + " driver needs the in-process API and fake clock"
	}
	if why, ok := blackboxClockFixtures[fx.ID]; ok {
		return "black-box: clock-dependent fixture (" + why + ")"
	}
	for _, a := range p.Block.Actions {
		switch a.Verb {
		case "advance-clock", "set-now", "tick-recover", "kill-runner", "new-runner", "claim-and-die":
			return "black-box: action " + a.Verb + " needs the suite clock or a killed worker"
		}
	}
	return ""
}
