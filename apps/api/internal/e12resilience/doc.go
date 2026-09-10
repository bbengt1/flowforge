// Package e12resilience holds the E12.2 operational resilience and
// capacity rehearsal (Relates to #183 / Part of #181).
//
// Tests here measure backup-adjacent restore, worker-loss recovery,
// queue lag, and bounded load peaks. Headroom claims require at least
// 2× configured/measured capacity versus those peaks.
package e12resilience
