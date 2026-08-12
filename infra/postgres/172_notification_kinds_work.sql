-- ============================================================================
-- 172_notification_kinds_work.sql — the notification vocabulary learns about
-- work events (WS-27bk, Project Operations).
--
-- `ProjectApp_Plan.md` §20.2 asks the Complete dialog for a "notify team
-- members" checkbox and notes that without a field behind it "the control is a
-- lie". §20.3's handoff likewise says the recipient is told. Both need a kind
-- `pm_notifications` will accept, and its CHECK allows exactly three.
--
-- Three, not one: `completed`, `handoff` and `blocked` are different sentences
-- in the bell, and collapsing them onto one kind would make the inbox unable
-- to say which happened. `blocked` is included now rather than later because
-- the blocker dialog lands in the same slice and would otherwise be the third
-- migration in a week touching one CHECK.
--
-- ## R6
--
-- A **widening**. Every stored row already satisfies the larger set, so the
-- `NOT VALID` + `VALIDATE` dance for tightening does not apply, and old code
-- keeps writing the old three legally during the deploy window.
--
-- ⚠️ `notifications.NOTIFICATION_KINDS` mirrors this CHECK and `notify()`
-- refuses an unknown kind BEFORE the insert. Update both or the widening is
-- decorative — this is the third time this pattern has appeared in this
-- workstream (migration 150's `attachment`, 171's `category`), so it is fenced:
-- `test_the_notification_kind_mirror_is_exact`.
--
-- Idempotent per infra/postgres/README.md.
-- ============================================================================

BEGIN;

ALTER TABLE pm_notifications DROP CONSTRAINT IF EXISTS pm_notifications_kind_check;
ALTER TABLE pm_notifications ADD CONSTRAINT pm_notifications_kind_check
    CHECK (kind IN (
        'assigned', 'mention', 'comment',
        -- WS-27bk. Opt-in on the Complete dialog, default OFF (§0.5).
        'completed',
        -- Never opt-in: being handed work you did not ask for is exactly the
        -- thing you must be told about (§17, "ownership never changes
        -- silently").
        'handoff',
        -- Raised against work somebody else owns.
        'blocked'
    ));

COMMIT;
