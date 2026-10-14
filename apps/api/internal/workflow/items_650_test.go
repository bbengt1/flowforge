package workflow

import "testing"

// #650 E3.1: the items PortKind and the item caps.

func TestItemsPortKindCompatibility(t *testing.T) {
	p := func(k PortKind) Port { return Port{Name: "p", Kind: k} }
	cases := []struct {
		from, to PortKind
		want     bool
	}{
		{PortItems, PortItems, true},
		{PortItems, PortAny, true},
		{PortAny, PortItems, true},
		{PortObject, PortItems, true}, // single object reads as a one-item list
		{PortItems, PortObject, false},
		{PortItems, PortString, false},
		{PortString, PortItems, false},
		{PortKind("list"), PortItems, false},
		{PortKind("list"), PortAny, false},
	}
	for _, c := range cases {
		if got := Compatible(p(c.from), p(c.to)); got != c.want {
			t.Fatalf("%s -> %s = %v, want %v", c.from, c.to, got, c.want)
		}
	}
}

func TestCatalogPortKindsAreKnown(t *testing.T) {
	for _, n := range CoreCatalog().Nodes {
		for _, ports := range [][]Port{n.Inputs, n.Outputs} {
			for _, port := range ports {
				if !ValidPortKind(port.Kind) {
					t.Fatalf("%s.%s has unknown kind %q", n.Type, port.Name, port.Kind)
				}
			}
		}
	}
}

func TestItemCaps(t *testing.T) {
	if MaxItemBytes != 16384 || MaxItemsPerPort != 1000 || MaxStepItemBytes != 4<<20 || MaxRunItemBytes != 64<<20 {
		t.Fatal("item caps drifted from #650 rev 3 / migration 000051 CHECKs")
	}
	if MaxItemBytes != MaxPortBytes {
		t.Fatal("MaxItemBytes must match MaxPortBytes")
	}
}
