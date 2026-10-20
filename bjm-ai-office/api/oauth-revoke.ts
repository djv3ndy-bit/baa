import { createOAuthRouteHandler } from '../server/chat-http.js';
export default createOAuthRouteHandler('revoke', 'POST');
