require('dotenv').config();
const ethers = require('ethers');
const axios = require('axios');
const { WebhookClient } = require('discord.js');

// Configuration
const ALCHEMY_WS_URL = process.env.ALCHEMY_WS_URL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

// Initialize providers and webhook
const provider = new ethers.providers.WebSocketProvider(ALCHEMY_WS_URL);
const webhookClient = new WebhookClient({ url: DISCORD_WEBHOOK_URL });

// Cache for token metadata to reduce API calls
const tokenCache = new Map();

// ERC-20 ABI for validation
const erc20Abi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
];

// Function to check if an address is an ERC-20 contract
async function isERC20Contract(address) {
  try {
    const contract = new ethers.Contract(address, erc20Abi, provider);
    await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
      contract.totalSupply()
    ]);
    return true; // All ERC-20 functions exist
  } catch {
    return false; // Not an ERC-20 contract
  }
}

// Function to fetch token metadata
async function getTokenMetadata(contractAddress) {
  if (tokenCache.has(contractAddress)) return tokenCache.get(contractAddress);
  try {
    const contract = new ethers.Contract(contractAddress, erc20Abi, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
      contract.totalSupply()
    ]);
    let icon = 'N/A', volume = 'N/A';
    try {
      const cgResponse = await axios.get(
        `https://api.coingecko.com/api/v3/coins/ethereum/contract/${contractAddress}`,
        { timeout: 5000 }
      );
      icon = cgResponse.data.image?.small || 'N/A';
      volume = cgResponse.data.market_data?.total_volume?.usd || 'N/A';
    } catch {
      if (ETHERSCAN_API_KEY) {
        try {
          const esResponse = await axios.get(
            `https://api.etherscan.io/api?module=token&action=tokeninfo&contractaddress=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`,
            { timeout: 5000 }
          );
          if (esResponse.data.result?.[0]) icon = esResponse.data.result[0].logo || 'N/A';
        } catch {}
      }
    }
    const metadata = { name, symbol, decimals, totalSupply: ethers.utils.formatEther(totalSupply), icon, volume };
    tokenCache.set(contractAddress, metadata);
    return metadata;
  } catch (error) {
    console.error(`Error fetching metadata for ${contractAddress}:`, error);
    return { name: 'Unknown', symbol: 'Unknown', decimals: 'N/A', totalSupply: 'N/A', icon: 'N/A', volume: 'N/A' };
  }
}

// Function to send Discord notification
async function sendDiscordNotification(contractAddress, txHash) {
  const metadata = await getTokenMetadata(contractAddress);
  const message = {
    embeds: [{
      title: 'New ERC-20 Token Deployed',
      color: 0x00ff00,
      fields: [
        { name: 'Contract Address', value: contractAddress, inline: true },
        { name: 'Token Name', value: metadata.name, inline: true },
        { name: 'Symbol', value: metadata.symbol, inline: true },
        { name: 'Decimals', value: metadata.decimals.toString(), inline: true },
        { name: 'Total Supply', value: metadata.totalSupply, inline: true },
        { name: 'Icon', value: metadata.icon, inline: true },
        { name: 'Volume (USD)', value: metadata.volume.toString(), inline: true },
        { name: 'Transaction Hash', value: txHash, inline: true },
        { name: 'Timestamp', value: new Date().toISOString(), inline: true },
      ],
    }],
  };
  try {
    await webhookClient.send(message);
    console.log(`Notification sent for new token at ${contractAddress}`);
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

// Main function to listen for new ERC-20 contract deployments
async function listenForNewTokens() {
  console.log('Starting ERC-20 token deployment listener...');
  console.log('Ethers version:', ethers.version);
  provider.on('pending', async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (tx && !tx.to && tx.data && tx.data !== '0x') { // Contract creation
        const receipt = await tx.wait();
        if (receipt.contractAddress) {
          const isERC20 = await isERC20Contract(receipt.contractAddress);
          if (isERC20) {
            console.log(`New ERC-20 token detected at ${receipt.contractAddress}`);
            await sendDiscordNotification(receipt.contractAddress, txHash);
          }
        }
      }
    } catch (error) {
      console.error('Error processing transaction:', error);
    }
  });
  provider.websocket.on('error', (error) => {
    console.error('WebSocket error:', error);
    setTimeout(listenForNewTokens, 5000);
  });
}

// Start the listener
listenForNewTokens().catch((error) => {
  console.error('Failed to start listener:', error);
  process.exit(1);
});