const policy=(name,capabilities=[])=>Object.freeze({name,mode:'analyze_draft_recommend',capabilities,external_publish:false,email_send:false,dm_send:false,ad_spend:false,financial_write:false,user_write:false,production_write:false,owner_approval_required_for_external_action:true});

export const MARKETING_AGENT=policy('marketing-growth',['campaign_planning','growth_experiments','email_drafts','landing_page_recommendations','acquisition_analysis']);
export const SOCIAL_AGENT=policy('social-media',['content_calendar','caption_drafts','post_ideas','creative_briefs','engagement_analysis']);
export const SALES_AGENT=policy('cafe-sales',['lead_prioritization','outreach_drafts','followup_planning','onboarding_recommendations','pipeline_analysis']);
export const ANALYTICS_AGENT=policy('analytics-product',['kpi_analysis','funnel_analysis','retention_analysis','product_recommendations','experiment_analysis']);

export const MANAGER_AGENT=Object.freeze({name:'operations-manager',mode:'coordinate_prioritize_escalate',agents:['engineering-reliability','customer-support','billing-subscriptions','marketing-growth','social-media','cafe-sales','analytics-product'],can_merge_code:false,can_deploy:false,can_send_external_messages:false,can_spend_money:false,can_modify_users:false,can_change_billing:false,can_change_security:false,owner_approval_required:['production_change','financial_action','external_campaign_launch','account_or_user_action','security_change','destructive_action']});

export function classifyOwnerApproval(action=''){
 const text=String(action).toLowerCase();
 const protectedAction=/(deploy|production|merge|refund|charge|price|billing|cancel subscription|delete|ban|suspend|security|rls|password|send email|publish|post to|launch campaign|ad spend|message customer|dm)/.test(text);
 return {approval_required:protectedAction,reason:protectedAction?'Action can affect production, money, users, security, or external communications.':'Routine internal analysis/drafting can proceed without owner approval.'};
}

export function teamStatus(){return {version:'bjm-ai-team-v1',control_center:'chatgpt-bjm-office',agents:{manager:MANAGER_AGENT,marketing:MARKETING_AGENT,social:SOCIAL_AGENT,sales:SALES_AGENT,analytics:ANALYTICS_AGENT},operating_rule:'Agents may analyze, draft, prioritize, and recommend. Consequential actions return to the owner for approval.'};}
