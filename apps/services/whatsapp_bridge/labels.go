package main

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/types/events"
)

// Native WhatsApp labels/lists live in the account's app-state (the `regular`
// collection). whatsmeow surfaces them as LabelEdit (a label was created/renamed/
// recoloured/deleted) and LabelAssociationChat (a chat was tagged/untagged) events.
// We mirror them read-only into the triage inbox so the founder sees the same
// "Clients / Suppliers / Follow up" tags they set up inside WhatsApp.
//
// Two subtleties handled here:
//   • Existing labels only arrive on a *full* app-state sync, and whatsmeow
//     suppresses full-sync events unless EmitAppStateEventsOnFullSync is set
//     (done in newClient) AND a full sync is actually run. ensureLabelSync forces
//     that once per account (guarded by a meta flag) so a number paired before
//     this feature existed still backfills its labels.
//   • WhatsApp's built-in *lists* (Unread, Groups, Favourites, Archived, …) come
//     through the same channel as real labels. isSystemList drops them so only
//     the user's own labels/lists surface.

// labelSyncedFlag marks that we've done the one-time forced full app-state sync
// that backfills a number's existing labels.
const labelSyncedFlag = "labels_synced"

// labelColorPalette maps WhatsApp's label colour index to a hex swatch. WhatsApp
// stores a small palette index (not an RGB value); this mirrors that palette so a
// label renders in roughly the colour the user picked. Index is taken modulo the
// palette length defensively.
var labelColorPalette = []string{
	"#8fa5b6", // 0  slate
	"#eb7185", // 1  rose
	"#f4a851", // 2  amber
	"#e6c34d", // 3  gold
	"#8fd14f", // 4  green
	"#3fb984", // 5  teal
	"#4bc2d6", // 6  cyan
	"#5aa1f2", // 7  blue
	"#7c86f0", // 8  indigo
	"#b07cf0", // 9  violet
	"#e070c0", // 10 magenta
	"#f06292", // 11 pink
	"#c98a5e", // 12 tan
	"#9e9e9e", // 13 grey
	"#66bb6a", // 14 leaf
	"#26a69a", // 15 sea
	"#42a5f5", // 16 sky
	"#7e57c2", // 17 grape
	"#ec407a", // 18 cerise
	"#78909c", // 19 steel
}

func labelColorHex(idx int32) string {
	n := int32(len(labelColorPalette))
	i := idx % n
	if i < 0 {
		i += n
	}
	return labelColorPalette[i]
}

// isSystemList reports whether a list type is one of WhatsApp's built-in filters
// (Unread, Groups, Favourites, Archived, …) rather than a user-created label.
// Denylist rather than allowlist: any label the user makes (including older ones
// that report no type) is kept — only the known system filters are dropped.
func isSystemList(t waSyncAction.LabelEditAction_ListType) bool {
	switch t {
	case waSyncAction.LabelEditAction_UNREAD,
		waSyncAction.LabelEditAction_GROUPS,
		waSyncAction.LabelEditAction_FAVORITES,
		waSyncAction.LabelEditAction_COMMUNITY,
		waSyncAction.LabelEditAction_DRAFTED,
		waSyncAction.LabelEditAction_AI_HANDOFF,
		waSyncAction.LabelEditAction_CHANNELS,
		waSyncAction.LabelEditAction_AI_RESPONDING,
		waSyncAction.LabelEditAction_ARCHIVED,
		waSyncAction.LabelEditAction_LOCKED,
		waSyncAction.LabelEditAction_INVITES:
		return true
	default:
		return false
	}
}

// onLabelEdit mirrors a single label create/rename/recolour/delete to the gateway.
func (m *SessionManager) onLabelEdit(s *Session, e *events.LabelEdit) {
	a := e.Action
	if a == nil {
		return
	}
	if isSystemList(a.GetType()) {
		return // a built-in WhatsApp filter, not a user label
	}
	name := a.GetName()
	if name == "" && !a.GetDeleted() {
		name = "Label " + e.LabelID // predefined labels can arrive nameless
	}
	lbl := bridgeLabel{
		WALabelID:    e.LabelID,
		Name:         name,
		Color:        labelColorHex(a.GetColor()),
		ColorIndex:   a.GetColor(),
		ListType:     a.GetType().String(),
		PredefinedID: a.GetPredefinedID(),
		SortOrder:    a.GetOrderIndex(),
		Active:       a.GetIsActive(),
		Deleted:      a.GetDeleted(),
	}
	if err := m.gw.IngestLabels(context.Background(), labelsPayload{
		AccountID: s.accountID, Labels: []bridgeLabel{lbl},
	}); err != nil {
		m.log.Warnf("label edit %s (%s): %v", s.accountID, e.LabelID, err)
	}
}

// onLabelAssocChat mirrors a single chat↔label (un)tag to the gateway.
func (m *SessionManager) onLabelAssocChat(s *Session, e *events.LabelAssociationChat) {
	labeled := e.Action != nil && e.Action.GetLabeled()
	if err := m.gw.IngestLabels(context.Background(), labelsPayload{
		AccountID: s.accountID,
		Associations: []bridgeLabelAssoc{{
			WALabelID: e.LabelID,
			ChatID:    e.JID.String(),
			Labeled:   labeled,
		}},
	}); err != nil {
		m.log.Warnf("label assoc %s (%s): %v", s.accountID, e.LabelID, err)
	}
}

// ensureLabelSync forces a one-time full sync of the `regular` app-state
// collection so a number's EXISTING labels are emitted (and mirrored). Guarded by
// a meta flag so it runs once per account, not on every reconnect. Called (in a
// goroutine) whenever a session connects.
func (m *SessionManager) ensureLabelSync(s *Session) {
	ctx := context.Background()
	if done, _ := m.meta.HasFlag(ctx, s.accountID, labelSyncedFlag); done {
		return
	}
	// Let app-state keys settle after connect before requesting a snapshot.
	time.Sleep(8 * time.Second)
	if s.client == nil || !s.client.IsLoggedIn() {
		return // retry on the next connect (flag stays unset)
	}
	if err := s.client.FetchAppState(ctx, appstate.WAPatchRegular, true, false); err != nil {
		m.log.Warnf("label full-sync %s: %v", s.accountID, err)
		return
	}
	if err := m.meta.SetFlag(ctx, s.accountID, labelSyncedFlag); err != nil {
		m.log.Warnf("mark labels synced %s: %v", s.accountID, err)
	}
	m.log.Infof("label sync complete for %s", s.accountID)
}
