-- Cache statement-invariant identity checks without changing authorization.
-- A busy database should fail this migration promptly rather than queue writers.
set local lock_timeout = '3s';

create index if not exists discovery_messages_sender_id_idx
  on public.discovery_messages (sender_id);

alter policy "Users can view their notifications" on public.notifications
  using (recipient_id = (select auth.uid()));
alter policy "Users can mark their notifications read" on public.notifications
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

alter policy "Users can view notification preferences" on public.notification_preferences
  using (user_id = (select auth.uid()));
alter policy "Users can create notification preferences" on public.notification_preferences
  with check (user_id = (select auth.uid()));
alter policy "Users can update notification preferences" on public.notification_preferences
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy "Users manage their own job swipes" on public.job_swipes
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy "Cafe owners can view own subscription" on public.cafe_subscriptions
  using (user_id = (select auth.uid()));

alter policy "Members can record own product events" on public.product_events
  with check (user_id = (select auth.uid()));
