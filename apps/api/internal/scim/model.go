package scim

import "time"

// Record is the directory row for one FlowForge user. The SCIM id is
// users.id. DeprovisionedAt hides the user from SCIM (DELETE). Account
// status stays on users.status. No password or bearer is stored here.
type Record struct {
	UserID          string
	UserName        string
	ExternalID      string
	DeprovisionedAt *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Active reports whether DELETE has not removed the directory row.
func (r Record) Active() bool {
	return r.UserID != "" && r.DeprovisionedAt == nil
}
