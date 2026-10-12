package fixturesuite

// Part is one runnable sub-case of a fixture on one driver.
type Part struct {
	Name   string
	Block  Block // effective expectations (case merged over the top level)
	XFail  *XFail
	Driver string
}

func driverMatch(list []string, d string) bool {
	for _, x := range list {
		if x == "all" || x == d {
			return true
		}
	}
	return false
}

// Parts expands a fixture into (part, driver) pairs. A case inherits the
// top level's drivers, publish, start, run and audit when it sets none.
// An xfail applies to a part when its part is the case name or "all"
// (a fixture without cases is one part, so any top-level xfail applies)
// and its drivers include the driver or "all".
func Parts(top Block) []Part {
	cases := top.Cases
	if len(cases) == 0 {
		only := top
		only.Name = "all"
		cases = []Block{only}
	}
	var out []Part
	for _, c := range cases {
		b := c
		if len(b.Drivers) == 0 {
			b.Drivers = top.Drivers
		}
		if b.Publish == nil {
			b.Publish = top.Publish
		}
		if b.Start == nil {
			b.Start = top.Start
		}
		if b.Run == nil && b.Today == nil {
			b.Run = top.Run
		}
		if b.Audit == nil && b.Today == nil {
			b.Audit = top.Audit
		}
		tags := append(append([]XFail{}, c.XFail...), top.XFail...)
		for _, d := range b.Drivers {
			p := Part{Name: c.Name, Block: b, Driver: d}
			for i := range tags {
				x := tags[i]
				applies := x.Part == "all" || x.Part == c.Name || len(top.Cases) == 0
				if applies && driverMatch(x.Drivers, d) {
					p.XFail = &x
					break
				}
			}
			out = append(out, p)
		}
	}
	return out
}
