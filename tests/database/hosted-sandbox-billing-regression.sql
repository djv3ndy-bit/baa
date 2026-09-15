-- Run only in the approved, empty test project iqtpsxxlpncaeabbcxht.
-- Tests database behavior with synthetic provider records, not real purchases.
-- A successful final exception rolls back every fixture in the subtransaction.
create or replace function pg_temp.bjm_assert(ok boolean, label text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'Regression failed: %', label; end if;
end $$;

do $$
declare
  cafe uuid := gen_random_uuid(); other_cafe uuid := gen_random_uuid();
  barista uuid := gen_random_uuid(); website_cafe uuid := gen_random_uuid();
  binding uuid; other_binding uuid; attempt uuid := gen_random_uuid();
  event_claim uuid := gen_random_uuid(); second_claim uuid := gen_random_uuid();
  first_job uuid := gen_random_uuid(); second_job uuid := gen_random_uuid();
  third_job uuid := gen_random_uuid(); application uuid := gen_random_uuid();
  result jsonb; denied boolean; before_count integer;
begin
  perform pg_temp.bjm_assert((select environment='Sandbox' from private.native_billing_configuration), 'sandbox-only guard');
  perform pg_temp.bjm_assert((select count(*)=0 from auth.users), 'empty dedicated test environment');
  begin
    insert into auth.users(id,email,raw_user_meta_data) values
      (cafe,'cafe-'||cafe||'@example.invalid','{"role":"cafe_owner_manager","cafe_name":"Synthetic Cafe","location":"Miami, FL"}'),
      (other_cafe,'cafe-'||other_cafe||'@example.invalid','{"role":"cafe_owner_manager","cafe_name":"Other Synthetic Cafe","location":"Miami, FL"}'),
      (website_cafe,'cafe-'||website_cafe||'@example.invalid','{"role":"cafe_owner_manager","cafe_name":"Synthetic Website Subscriber","location":"Miami, FL"}'),
      (barista,'barista-'||barista||'@example.invalid','{"role":"barista","display_name":"Synthetic Barista","location":"Miami, FL"}');
    perform pg_temp.bjm_assert((select count(*)=4 from public.profiles), 'existing signup trigger creates role-correct profiles');
    update public.profiles set avatar_url='https://example.invalid/test-avatar.png',bio='Synthetic test profile',
      skills=array['Espresso'],availability='Weekdays',experience='Three years',pay_expectation='$20/hour',
      cafe_address='1 Test Street',open_hours='Weekdays',shop_type='Cafe',barista_preferences=array['Espresso'],is_discoverable=true;
    insert into public.cafe_subscriptions(user_id,status) values(cafe,'expired'),(other_cafe,'expired');
    insert into public.cafe_subscriptions(user_id,status,stripe_customer_id,stripe_subscription_id)
      values(website_cafe,'active','cus_synthetic_test_only','sub_synthetic_test_only');
    perform pg_temp.bjm_assert(private.cafe_has_paid_job_entitlement(website_cafe), 'existing website paid access preserved');
    perform pg_temp.bjm_assert(public.native_checkout_claim(website_cafe,'apple','Sandbox',gen_random_uuid()) is null, 'website subscriber cannot buy duplicate native subscription');

    binding := public.native_billing_account(cafe);
    other_binding := public.native_billing_account(other_cafe);
    perform pg_temp.bjm_assert(binding<>cafe and binding<>other_binding and binding=public.native_billing_account(cafe), 'stable account-bound opaque store token');
    denied:=false;
    begin perform public.native_billing_account(barista); exception when raise_exception then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'barista cannot create billing account');

    perform set_config('request.jwt.claim.sub',cafe::text,true);
    execute 'set local role authenticated';
    insert into public.jobs(id,owner_id,title,location,description,address_line1,city,state,postal_code)
      values(first_job,cafe,'Synthetic first job','Miami, FL','Temporary test record','1 Test Street','Miami','FL','33101');
    perform pg_temp.bjm_assert((select count(*)=1 from public.jobs where owner_id=cafe), 'first job remains free');
    denied:=false;
    begin
      insert into public.jobs(owner_id,title,location,description,address_line1,city,state,postal_code)
        values(cafe,'Synthetic second job','Miami, FL','Temporary test record','1 Test Street','Miami','FL','33101');
    exception when sqlstate 'PJB01' then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'second lifetime job requires verified paid access');
    denied:=false;
    begin perform public.native_billing_account(cafe); exception when insufficient_privilege then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'client cannot call privileged billing RPC');
    execute 'reset role';

    perform set_config('request.jwt.claim.sub',barista::text,true);
    execute 'set local role authenticated';
    insert into public.applications(id,job_id,barista_id) values(application,first_job,barista);
    perform pg_temp.bjm_assert((select status='interested' from public.applications where id=application), 'interest remains distinct from mutual match');
    denied:=false;
    begin insert into public.applications(job_id,barista_id) values(first_job,barista);
    exception when unique_violation then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'duplicate interest is rejected');
    denied:=false;
    begin update public.applications set status='matched' where id=application;
    exception when insufficient_privilege then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'barista cannot confirm own mutual match');
    denied:=false;
    begin insert into public.messages(application_id,sender_id,body) values(application,barista,'Synthetic premature message');
    exception when insufficient_privilege then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'messaging remains unavailable before mutual match');
    execute 'reset role';
    perform set_config('request.jwt.claim.sub',cafe::text,true);
    execute 'set local role authenticated';
    update public.applications set status='matched' where id=application;
    perform pg_temp.bjm_assert((select status='matched' from public.applications where id=application), 'cafe confirms mutual match without paid subscription');
    execute 'reset role';
    perform set_config('request.jwt.claim.sub',barista::text,true);
    execute 'set local role authenticated';
    insert into public.messages(application_id,sender_id,body) values(application,barista,'Synthetic interview message');
    perform pg_temp.bjm_assert((select count(*)=1 from public.messages where application_id=application), 'matched interview messaging stays free');
    execute 'reset role';
    perform set_config('request.jwt.claim.sub',other_cafe::text,true);
    execute 'set local role authenticated';
    perform pg_temp.bjm_assert((select count(*)=0 from public.messages where application_id=application), 'unrelated account cannot read conversation');
    execute 'reset role';
    perform set_config('request.jwt.claim.sub',cafe::text,true);
    execute 'set local role authenticated';
    perform public.mark_conversation_read(application);
    perform pg_temp.bjm_assert((select count(*)=0 from public.messages where application_id=application and read_at is null), 'existing read action clears recipient unread messages');
    execute 'reset role';

    result:=public.native_checkout_claim(cafe,'apple','Sandbox',attempt);
    perform pg_temp.bjm_assert(result->>'attemptId'=attempt::text, 'native checkout can reserve a free cafe account');
    perform pg_temp.bjm_assert(public.native_checkout_claim(cafe,'apple','Sandbox',gen_random_uuid()) is null, 'repeated checkout cannot create duplicate attempt');
    perform pg_temp.bjm_assert(public.claim_stripe_checkout(cafe,gen_random_uuid(),gen_random_uuid(),'web','hosted') is null, 'native reservation blocks competing website checkout');
    perform pg_temp.bjm_assert(public.native_checkout_start(cafe,'Sandbox',attempt), 'reserved native checkout starts');
    perform pg_temp.bjm_assert(not public.native_checkout_start(cafe,'Sandbox',attempt), 'repeated start cannot authorize a second launch');
    perform pg_temp.bjm_assert(public.native_checkout_cancel(cafe,'Sandbox',attempt,false), 'explicit store cancellation releases attempt');
    perform pg_temp.bjm_assert(not public.native_checkout_pending(cafe,'Sandbox'), 'cancelled checkout leaves no pending reservation');

    perform pg_temp.bjm_assert(public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-tx','active',now()+interval '30 days',null,true,0)='applied', 'verified provider record grants sandbox access');
    perform pg_temp.bjm_assert(public.native_billing_access(cafe,'Sandbox') and not public.native_billing_access(cafe,'Production'), 'sandbox access cannot grant production access');
    perform pg_temp.bjm_assert(public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-tx','active',now()+interval '30 days',null,true,0)='retry', 'stale receipt revision requires re-verification');
    perform pg_temp.bjm_assert(public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-tx','active',now()+interval '30 days',null,true,1)='duplicate', 'repeated verified transaction has no duplicate effect');
    denied:=false;
    begin
      perform public.native_billing_apply(other_cafe,other_binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-tx','active',now()+interval '30 days',null,true,1);
    exception when raise_exception then denied:=true; end;
    perform pg_temp.bjm_assert(denied and not public.native_billing_access(other_cafe,'Sandbox'), 'restoration cannot transfer purchase to another account');
    perform pg_temp.bjm_assert(public.native_checkout_claim(cafe,'apple','Sandbox',gen_random_uuid()) is null, 'active native subscriber cannot purchase duplicate access');
    perform pg_temp.bjm_assert(public.claim_stripe_checkout(cafe,gen_random_uuid(),gen_random_uuid(),'web','hosted') is null, 'native subscriber cannot purchase duplicate website access');

    perform set_config('request.jwt.claim.sub',cafe::text,true);
    execute 'set local role authenticated';
    insert into public.jobs(id,owner_id,title,location,description,address_line1,city,state,postal_code) values
      (second_job,cafe,'Synthetic paid job','Miami, FL','Temporary test record','1 Test Street','Miami','FL','33101'),
      (third_job,cafe,'Another synthetic paid job','Miami, FL','Temporary test record','1 Test Street','Miami','FL','33101');
    perform pg_temp.bjm_assert((select count(*)=3 from public.jobs where owner_id=cafe), 'native paid access uses existing job creation rules');
    denied:=false;
    begin
      insert into public.jobs(owner_id,title,location,description,address_line1,city,state,postal_code)
        values(cafe,'Synthetic fourth job','Miami, FL','Temporary test record','1 Test Street','Miami','FL','33101');
    exception when sqlstate 'PJB04' then denied:=true; end;
    perform pg_temp.bjm_assert(denied, 'three active job limit preserved');
    execute 'reset role';

    perform pg_temp.bjm_assert(public.native_billing_claim_event('apple','Sandbox','synthetic-event',repeat('a',64),event_claim)='claimed', 'notification event can be claimed');
    perform pg_temp.bjm_assert(public.native_billing_claim_event('apple','Sandbox','synthetic-event',repeat('a',64),second_claim)='busy', 'concurrent event delivery cannot duplicate effects');
    perform pg_temp.bjm_assert(not public.native_billing_finish_event('apple','Sandbox','synthetic-event',second_claim,true), 'wrong worker cannot complete event');
    perform pg_temp.bjm_assert(public.native_billing_finish_event('apple','Sandbox','synthetic-event',event_claim,true), 'correct worker completes event');
    perform pg_temp.bjm_assert(public.native_billing_claim_event('apple','Sandbox','synthetic-event',repeat('a',64),second_claim)='duplicate', 'completed event delivery remains idempotent');

    perform pg_temp.bjm_assert(public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-tx','revoked',now()+interval '30 days',null,false,1)='applied', 'verified revocation updates access');
    perform pg_temp.bjm_assert(not public.native_billing_access(cafe,'Sandbox'), 'revoked subscription has no paid access');
    perform set_config('request.jwt.claim.sub',barista::text,true);
    execute 'set local role authenticated';
    perform pg_temp.bjm_assert((select count(*)=1 from public.jobs where owner_id=cafe), 'unpaid cafe retains first free published job only');
    execute 'reset role';
    perform pg_temp.bjm_assert((select count(*)=3 from public.jobs where owner_id=cafe), 'revocation preserves all saved jobs');
    perform pg_temp.bjm_assert(private.cafe_has_paid_job_entitlement(website_cafe), 'website subscriber access unaffected by native revocation');

    perform public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-renewal','active',now()+interval '60 days',null,true,2);
    perform pg_temp.bjm_assert(public.native_billing_access(cafe,'Sandbox'), 'verified renewal restores valid access');
    perform public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-renewal','active',now()-interval '1 day',null,false,3);
    perform pg_temp.bjm_assert(not public.native_billing_access(cafe,'Sandbox'), 'period expiration removes access without requiring notification');
    perform public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-renewal','grace',now()-interval '1 day',now()+interval '2 days',true,4);
    perform pg_temp.bjm_assert(public.native_billing_access(cafe,'Sandbox'), 'verified billing grace preserves paid access');
    perform public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-renewal','payment_required',now()-interval '1 day',null,true,5);
    perform pg_temp.bjm_assert(not public.native_billing_access(cafe,'Sandbox'), 'failed payment outside grace has no paid access');
    perform public.native_billing_apply(cafe,binding,'apple','Sandbox','synthetic-original','test.monthly','synthetic-pending','pending',null,null,true,6);
    perform pg_temp.bjm_assert(not public.native_billing_access(cafe,'Sandbox'), 'pending purchase does not grant access');
    perform pg_temp.bjm_assert(public.native_checkout_claim(cafe,'apple','Sandbox',gen_random_uuid()) is null, 'pending purchase prevents accidental duplicate checkout');

    raise exception using errcode='PTB01',message='Rollback successful synthetic test fixtures';
  exception when sqlstate 'PTB01' then null;
  end;
  perform pg_temp.bjm_assert((select count(*)=0 from auth.users), 'test users rolled back');
  perform pg_temp.bjm_assert((select count(*)=0 from public.jobs), 'test jobs rolled back');
  perform pg_temp.bjm_assert((select count(*)=0 from private.native_billing_subscriptions), 'test purchases rolled back');
end $$;
