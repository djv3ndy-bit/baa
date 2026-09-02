import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ownerApprovalFor, teamSnapshot } from './policy.js';

const app = express(); app.use(express.json());
const server = new McpServer({name:'bjm-ai-office',version:'0.1.0'});
const widgetUri='ui://bjm-ai-office/owner-v1';

server.registerResource('bjm-ai-office-widget',widgetUri,{},async()=>({contents:[{uri:widgetUri,mimeType:'text/html;profile=mcp-app',text:`<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/office.js"></script></body></html>`,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'Private Barista Job Match AI Office for owner reports, team status, and approval decisions.'}}]}));

server.registerTool('get_owner_overview',{title:'BJM Owner Overview',description:'Use this when the owner wants the AI Office overview. Returns a safe summary shell; provider adapters can fill live metrics without exposing credentials.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri}},async()=>({structuredContent:{screen:'overview',platform:{status:'connected-foundation'},support:{status:'ready'},billing:{status:'supervised'},approvals:{count:null},note:'Live provider adapters are the next wiring step.'},content:[{type:'text',text:'BJM AI Office overview opened.'}]}));

server.registerTool('get_ai_team_status',{title:'AI Team Status',description:'Use this when the owner wants to see the Barista Job Match AI team and each agent operating mode.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri}},async()=>({structuredContent:{screen:'team',agents:teamSnapshot()},content:[{type:'text',text:'Loaded the BJM AI team.'}]}));

server.registerTool('get_decision_queue',{title:'Owner Decision Queue',description:'Use this when the owner asks what needs approval. This tool is read-only and never executes a protected action.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri}},async()=>({structuredContent:{screen:'decisions',items:[],note:'Decision adapters will aggregate protected requests from Support, Billing, Engineering, Marketing and other agents.'},content:[{type:'text',text:'Loaded the owner decision queue.'}]}));

server.registerTool('request_owner_action',{title:'Prepare Owner Approval',description:'Use this when an agent has a proposed action. It classifies whether owner approval is required and prepares a review item; it does not execute the action.',inputSchema:{action:z.string().min(1).max(500),agent:z.string().min(1).max(80),summary:z.string().min(1).max(1500)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{ui:{resourceUri:widgetUri},'openai/outputTemplate':widgetUri}},async({action,agent,summary})=>{const policy=ownerApprovalFor(action);return {structuredContent:{screen:'decision',item:{action,agent,summary,...policy,status:policy.approvalRequired?'owner_review':'routine'}},content:[{type:'text',text:policy.approvalRequired?'Owner approval is required. No action was executed.':'This can remain an internal routine task. No external action was executed.'}]};});

app.post('/mcp',async(req,res)=>{const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});res.on('close',()=>transport.close());await server.connect(transport);await transport.handleRequest(req,res,req.body);});
app.get('/health',(_req,res)=>res.json({ok:true,app:'bjm-ai-office'}));
app.listen(Number(process.env.PORT||8787),()=>console.log('BJM AI Office MCP server ready'));
