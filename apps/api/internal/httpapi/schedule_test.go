package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const scheduleYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e103-schedule
spec:
  triggers:
    - id: nightly
      type: schedule
      timezone: America/Chicago
      cron: "0 * * * *"
      overlapPolicy: skip
      catchUp: 0
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

func TestScheduleCRUDTimezoneOverlapAndFailClosed(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, scheduleYAML)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e103-sched-viewer","role_keys":["viewer"]}`)

	t.Run("viewer cannot create", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowId":        created.Workflow.ID,
			"workflowVersionId": "00000000-0000-4000-8000-000000000001",
			"timezone":          "UTC",
			"interval":          "PT15M",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules", body, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e103-sched")

	t.Run("host identity rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowId":        created.Workflow.ID,
			"workflowVersionId": pub.Version.ID,
			"timezone":          "UTC",
			"interval":          "PT15M",
			"workspaceId":       ws.ID,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("unpublished version rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowId":        created.Workflow.ID,
			"workflowVersionId": "00000000-0000-4000-8000-000000000099",
			"timezone":          "UTC",
			"interval":          "PT15M",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("unknown timezone rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowId":        created.Workflow.ID,
			"workflowVersionId": pub.Version.ID,
			"timezone":          "Not/AZone",
			"interval":          "PT15M",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	body, _ := json.Marshal(map[string]any{
		"workflowId":        created.Workflow.ID,
		"workflowVersionId": pub.Version.ID,
		"timezone":          "America/Chicago",
		"interval":          "PT1M",
		"overlapPolicy":     "skip",
		"catchUp":           0,
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create schedule: %d %s", rec.Code, rec.Body.String())
	}
	var recd schedule.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &recd); err != nil {
		t.Fatal(err)
	}
	if recd.Timezone != "America/Chicago" || recd.OverlapPolicy != schedule.OverlapSkip || recd.CatchUp != 0 {
		t.Fatalf("defaults = %+v", recd)
	}
	if recd.NextFireAt.Before(base) || recd.NextFireAt.Equal(base) {
		t.Fatalf("nextFireAt should be after create clock, got %s", recd.NextFireAt)
	}

	t.Run("catalog and list", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/schedules/catalog", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("catalog: %d %s", rec.Code, rec.Body.String())
		}
		var cat schedule.Catalog
		if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil || !cat.TimezoneRequired || cat.DefaultCatchUp != 0 {
			t.Fatalf("catalog = %+v %v", cat, err)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/schedules?workflowId="+created.Workflow.ID, nil, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("disabled fails closed", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules/"+recd.ID+"/disable", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("disable: %d %s", rec.Code, rec.Body.String())
		}
		frozen.Store(base.Add(2 * time.Minute).UnixNano())
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/schedules/dispatch", []byte(`{"scheduleId":"`+recd.ID+`"}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("dispatch disabled: %d %s", rec.Code, rec.Body.String())
		}
		var out scheduleDispatchResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Items) != 0 {
			t.Fatalf("disabled schedules are not due: %+v", out.Items)
		}
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/schedules/"+recd.ID+"/enable", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("enable: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("dispatch starts then overlap skips", func(t *testing.T) {
		frozen.Store(base.Add(3 * time.Minute).UnixNano())
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/schedules/dispatch", []byte(`{"scheduleId":"`+recd.ID+`"}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("dispatch: %d %s", rec.Code, rec.Body.String())
		}
		var out scheduleDispatchResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Items) != 1 || out.Items[0].ExecutionID == "" {
			t.Fatalf("expected one fire, got %+v", out.Items)
		}
		if out.Items[0].Execution == nil || out.Items[0].Execution.PolicySnapshot["triggerType"] != schedule.TypeSchedule {
			t.Fatalf("triggerType = %+v", out.Items[0].Execution)
		}

		frozen.Store(base.Add(5 * time.Minute).UnixNano())
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/schedules/dispatch", []byte(`{"scheduleId":"`+recd.ID+`"}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("overlap dispatch: %d %s", rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Items) != 1 || out.Items[0].SkipReason != "overlap-skip" {
			t.Fatalf("overlap = %+v", out.Items)
		}
	})

	t.Run("delete", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodDelete, "/api/v1/schedules/"+recd.ID, []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
		}
	})
}

func TestScheduleChicagoTimezoneNextFire(t *testing.T) {
	now := time.Date(2026, 1, 15, 18, 30, 0, 0, time.UTC) // 12:30 Chicago winter
	rec := schedule.Record{Timezone: "America/Chicago", Cron: "0 12 * * *", OverlapPolicy: schedule.OverlapSkip, MisfirePolicy: schedule.MisfireIgnore}
	next, err := schedule.NextAfter(rec, now)
	if err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	local := next.In(loc)
	if local.Hour() != 12 || local.Minute() != 0 {
		t.Fatalf("next Chicago noon, got %s", local)
	}
	utcNext, err := schedule.NextAfter(schedule.Record{Timezone: "UTC", Cron: "0 12 * * *", OverlapPolicy: schedule.OverlapSkip, MisfirePolicy: schedule.MisfireIgnore}, now)
	if err != nil {
		t.Fatal(err)
	}
	if next.Equal(utcNext) {
		t.Fatalf("Chicago and UTC noon should differ in January, both %s", next)
	}
	_ = wfstore.ExecutionQueued
}
