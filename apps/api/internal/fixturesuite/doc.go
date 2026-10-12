// Package fixturesuite holds the Epic 0 (#651) acceptance fixture suite.
//
// It is test-only: all code lives in _test.go files. Each fixture under
// fixtures/<id>/ is a FlowForge workflow (workflow.yaml) plus its
// expectations (expect.yaml). The suite seeds a throwaway tenant, publishes
// the fixture, starts it, drives it through a worker driver, and asserts
// run status, step statuses, audit rows, and HTTP answers.
//
// Expected-fail is strict: a fixture (or one driver of it) tagged xfail
// that passes fails the suite until the tag is removed. Every xfail tag
// needs a reason and an issue ref (#NNN), and its part must name a case
// (or all); a tag that matches no case fails lint.
//
// Parts marked `build: fftest` use the test-only node test.flaky (#658)
// and run only under `go test -tags fftest`; `build: default` parts run
// only untagged. Scripted parts list `actions` (start, drive, retry, ...);
// see keys_test.go.
package fixturesuite
