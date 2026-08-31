/** @jsxImportSource preact */

import { render } from 'preact';
import { App } from './app';
import { ViewerApi } from './api';
import { bootstrapSession } from './token';

const session = bootstrapSession(window.location, window.history, window.sessionStorage);
const api = new ViewerApi(session.token);
const root = document.getElementById('app');

if (root) {
  render(<App api={api} initialToken={session.token} initialScope={session.scopeKey} />, root);
}
