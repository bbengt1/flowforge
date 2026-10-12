package fixturesuite

import "gopkg.in/yaml.v3"

func yamlUnmarshal(raw []byte, v any) error { return yaml.Unmarshal(raw, v) }
