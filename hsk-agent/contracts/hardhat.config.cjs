// Hardhat is used only as a local fork of HSK Chain mainnet for tests (scripts/fork-test.cjs).
module.exports = {
  solidity: '0.8.26',
  networks: {
    hardhat: {
      chainId: 177,
      hardfork: 'cancun',
      forking: { url: 'https://mainnet.hsk.xyz' },
      chains: { 177: { hardforkHistory: { cancun: 0 } } },
      mining: { auto: true },
    },
  },
};
