import { login, signup, logout, getUser, handleAuthCallback, updateUser, requestPasswordRecovery } from '@netlify/identity';
window.identity = { login, signup, logout, getUser, handleAuthCallback, updateUser, requestPasswordRecovery };
window.dispatchEvent(new Event('identity-ready'));
