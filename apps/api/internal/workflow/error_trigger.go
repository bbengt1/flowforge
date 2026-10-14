package workflow

import (
	"strings"

	"gopkg.in/yaml.v3"
)

// TriggerTypeError is the system trigger of a workspace error workflow
// (#649 S3). Its spec is empty, it must be the workflow's only trigger,
// and only the engine starts it.
const TriggerTypeError = "error"

// HasErrorTrigger reports whether doc declares the error trigger.
func HasErrorTrigger(doc *Document) bool {
	if doc == nil {
		return false
	}
	for _, t := range doc.Spec.Triggers {
		if t.Type == TriggerTypeError {
			return true
		}
	}
	return false
}

// IsErrorWorkflow reports whether a published version (its YAML or its
// stored summary) declares the error trigger. Callers that refuse manual
// or API starts fail closed: non-empty YAML that does not parse counts as
// an error workflow.
func IsErrorWorkflow(yamlDoc string, summary Summary) bool {
	for _, t := range summary.Triggers {
		if t.Type == TriggerTypeError {
			return true
		}
	}
	if strings.TrimSpace(yamlDoc) == "" {
		return false
	}
	// Read only spec.triggers[].type, so a stored version that no longer
	// passes today's validator (old or templated YAML) is still judged by
	// its triggers. YAML that does not decode at all fails closed.
	var doc struct {
		Spec struct {
			Triggers []struct {
				Type string `yaml:"type"`
			} `yaml:"triggers"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal([]byte(yamlDoc), &doc); err != nil {
		return true
	}
	for _, t := range doc.Spec.Triggers {
		if strings.TrimSpace(t.Type) == TriggerTypeError {
			return true
		}
	}
	return false
}

// IsOnlyErrorTriggerYAML reports whether the YAML parses and its only
// trigger is the error trigger: the shape the engine may start.
func IsOnlyErrorTriggerYAML(yamlDoc string) bool {
	res, errs := ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return false
	}
	t := res.Document.Spec.Triggers
	return len(t) == 1 && t[0].Type == TriggerTypeError
}
