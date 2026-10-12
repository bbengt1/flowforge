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
// needs a reason and an issue ref (#NNN).
package fixturesuite
