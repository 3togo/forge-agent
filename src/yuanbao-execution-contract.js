'use strict';

// Backward-compatible entry point for integrations that adopted the Yuanbao
// contract before it became the shared web-provider execution boundary.
const contract = require('./forge-execution-contract');

module.exports = {
  ...contract,
  buildYuanbaoExecutionContract(options = {}) {
    return contract.buildForgeExecutionContract({ ...options, provider: 'Yuanbao' });
  },
};
