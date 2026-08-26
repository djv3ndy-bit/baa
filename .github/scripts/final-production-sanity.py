from pathlib import Path

# Remove accidental command output prepended to auth pages.
for name in ('login.html','signup.html'):
    p=Path(name)
    s=p.read_text()
    if s.startswith('Already up to date.\n'):
        s=s[len('Already up to date.\n'):]
    p.write_text(s)

# Fix dashboard conversation-read call: Supabase's builder is thenable but .catch is not a safe API here.
p=Path('dashboard.html')
s=p.read_text()
s=s.replace("await activeClient.rpc('mark_conversation_read',{p_application_id:applicationId}).catch(()=>{});await refreshNotifications(false);", "const {error:readError}=await activeClient.rpc('mark_conversation_read',{p_application_id:applicationId});if(readError)console.warn('Could not mark conversation read:',readError);await refreshNotifications(false);")

# Keep the in-dashboard subscription summary aligned with the public pricing page.
old="function pricingSubscriptionHtml(){return `<div class=\"section-intro\"><p>Simple, transparent pricing for your café.</p></div><div class=\"pricing-panel\"><article class=\"pricing-offer\"><span class=\"pricing-kicker\">Your first 30 days are on us</span><div class=\"pricing-price\">$24.99 <small>/ month after your free trial</small></div><p class=\"empty\">Use BaristaMatch free for 30 days. After that, continue for just $24.99/month.</p><ul class=\"pricing-list\"><li>Create and manage job posts</li><li>Discover local baristas</li><li>Review candidate profiles</li><li>Track applications and matches</li><li>Manage your café profile</li><li>Cancel anytime</li></ul><div class=\"pricing-actions\"><a class=\"primary\" href=\"/pricing.html\">View full pricing</a><a class=\"secondary\" href=\"mailto:hello@baristajobmatch.com?subject=BaristaMatch%20Caf%C3%A9%20Subscription\">Contact support</a></div><p class=\"pricing-note\">No card is required for your 30-day trial. After the trial, continue for $24.99/month. Cancel anytime.</p></article></div>`}"
new="function pricingSubscriptionHtml(){return `<div class=\"section-intro\"><p>Simple, transparent pricing for your café.</p></div><div class=\"pricing-panel\"><article class=\"pricing-offer\"><span class=\"pricing-kicker\">30-day free trial</span><div class=\"pricing-price\">$24.99 <small>/ month</small></div><p class=\"empty\">Start free with no credit card required. After 30 days, choose $24.99/month or save with $239.99/year.</p><ul class=\"pricing-list\"><li>Full café hiring access</li><li>Discover local baristas</li><li>Review candidate profiles</li><li>Track applications and matches</li><li>Realtime messaging</li><li>Baristas stay free</li></ul><div class=\"pricing-actions\"><a class=\"primary\" href=\"/pricing.html\">Compare monthly & yearly</a><a class=\"secondary\" href=\"/support.html?type=billing\">Billing support</a></div><p class=\"pricing-note\">Yearly is $239.99 and saves $59.89 versus 12 monthly payments. Paid checkout activates after Stripe is connected.</p></article></div>`}"
if old in s:
    s=s.replace(old,new,1)
p.write_text(s)
