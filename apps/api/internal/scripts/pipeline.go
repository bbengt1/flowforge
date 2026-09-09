package scripts

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// Pipeline packages, scans, signs, and pins script artifacts.
type Pipeline struct {
	Store Store
	Key   []byte
}

// RuntimePin is the published runtime_profile revision used at package time.
type RuntimePin struct {
	ResourceID string
	VersionID  string
	Digest     string
	Spec       map[string]any
}

// Publish validates, packages, scans, signs, and stores one artifact.
func (p *Pipeline) Publish(ctx context.Context, scope isolation.Scope, in PublishInput) (Artifact, error) {
	if p == nil || p.Store == nil {
		return Artifact{}, ErrStoreUnavailable
	}
	if err := ValidatePublishInput(in); err != nil {
		return Artifact{}, err
	}
	_, raw, digest, err := Package(in)
	if err != nil {
		return Artifact{}, err
	}
	if existing, getErr := p.Store.GetByDigest(ctx, scope, digest); getErr == nil {
		if err := VerifyForDispatch(existing, p.Key); err != nil {
			return Artifact{}, err
		}
		return existing, nil
	}
	sig, err := SignDigest(p.Key, digest)
	if err != nil {
		return Artifact{}, err
	}
	now := time.Now().UTC()
	art := Artifact{
		Language:                strings.ToLower(strings.TrimSpace(in.Language)),
		Entrypoint:              strings.TrimSpace(in.Entrypoint),
		Digest:                  digest,
		Signature:               sig,
		ScanStatus:              ScanClean,
		Status:                  StatusPublished,
		RuntimeProfileID:        strings.TrimSpace(in.RuntimeProfileID),
		RuntimeProfileVersionID: strings.TrimSpace(in.RuntimeProfileVersionID),
		RuntimeProfileDigest:    strings.TrimSpace(in.RuntimeProfileDigest),
		SourceBytes:             len(in.Source),
		Metadata:                AuditMetadata(in, digest, ScanClean),
		CreatedBy:               scope.ActorID(),
		CreatedAt:               now,
		StorageRef:              "script:" + strings.TrimPrefix(digest, "sha256:"),
		Package:                 raw,
	}
	return p.Store.Put(ctx, scope, art)
}

// PublishNodes packages every script node against pinned runtime profiles.
func (p *Pipeline) PublishNodes(ctx context.Context, scope isolation.Scope, workflowVersionID string, nodes []NodeSpec, profiles []RuntimePin) ([]VersionPin, error) {
	if len(nodes) == 0 {
		return []VersionPin{}, nil
	}
	byID := map[string]RuntimePin{}
	for _, pin := range profiles {
		byID[pin.ResourceID] = pin
	}
	var out []VersionPin
	for _, node := range nodes {
		profileID, _ := node.With["runtimeProfileId"].(string)
		profileID = strings.TrimSpace(profileID)
		pin, ok := byID[profileID]
		if !ok {
			return nil, engineError(CodeInvalidRuntimeProfile, "script nodes require a pinned runtime profile revision.", http.StatusBadRequest)
		}
		in, inErr := InputFromNode(node, pin.ResourceID, pin.VersionID, pin.Digest, pin.Spec)
		if inErr != nil {
			return nil, inErr
		}
		in.WorkflowVersionID = workflowVersionID
		art, pubErr := p.Publish(ctx, scope, in)
		if pubErr != nil {
			return nil, pubErr
		}
		out = append(out, VersionPin{
			WorkflowVersionID: workflowVersionID,
			NodeID:            node.ID,
			NodeType:          node.Type,
			ArtifactID:        art.ID,
			Digest:            art.Digest,
			ScanStatus:        art.ScanStatus,
			Signature:         art.Signature,
			Language:          art.Language,
			Entrypoint:        art.Entrypoint,
		})
	}
	return p.Store.BindVersion(ctx, scope, workflowVersionID, out)
}

// VerifyNodePins fails closed when script nodes lack a clean signed pin.
func (p *Pipeline) VerifyNodePins(ctx context.Context, scope isolation.Scope, workflowVersionID string, nodes []NodeSpec) error {
	if len(nodes) == 0 {
		return nil
	}
	if p == nil || p.Store == nil {
		return ErrStoreUnavailable
	}
	pins, err := p.Store.ListVersionPins(ctx, scope, workflowVersionID)
	if err != nil {
		return err
	}
	byNode := map[string]VersionPin{}
	for _, pin := range pins {
		byNode[pin.NodeID] = pin
	}
	for _, node := range nodes {
		pin, ok := byNode[node.ID]
		if !ok {
			return ErrMutable
		}
		art, getErr := p.Store.Get(ctx, scope, pin.ArtifactID)
		if getErr != nil {
			return getErr
		}
		if art.Digest != pin.Digest {
			return ErrMutable
		}
		if err := VerifyForDispatch(art, p.Key); err != nil {
			return err
		}
	}
	return nil
}
