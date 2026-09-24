'use strict';

const { LOGIN_STATES, probeProviderLogin } = require('./provider-login-status');

// Compatibility facade for the original Yuanbao-only tray/status API.
function probeYuanbaoLogin(options = {}) {
  return probeProviderLogin('yuanbao', options);
}

module.exports = { LOGIN_STATES, probeYuanbaoLogin };
