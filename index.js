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

// ERC-20 Transfer event ABI
const transferEventAbi = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

// Function to check if an address is a contract
async function isContract(address) {
  try {
    const code = await provider.getCode(address);
    return code !== '0x';
  } catch {
    return false;
  }
}

// Function to fetch token metadata
async function getTokenMetadata(contractAddress) {
  if (tokenCache.has(contractAddress)) return tokenCache.get(contractAddress);
  try {
    const contract = new ethers.Contract(contractAddress, [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
    ], provider);
    const [name, symbol] = await Promise.all([contract.name(), contract.symbol()]);
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
    const metadata = { name, symbol, icon, volume };
    tokenCache.set(contractAddress, metadata);
    return metadata;
  } catch (error) {
    console.error(`Error fetching metadata for ${contractAddress}:`, error);
    return { name: 'Unknown', symbol: 'Unknown', icon: 'N/A', volume: 'N/A' };
  }
}

// Function to send Discord notification
async function sendDiscordNotification(event) {
  const { contractAddress, to, value } = event;
  const metadata = await getTokenMetadata(contractAddress);
  const isMinterContract = await isContract(to);
  const anonymity = isMinterContract ? 'Contract (Potentially Anonymous)' : 'Wallet (Likely Non-Anonymous)';
  const message = {
    embeds: [{
      title: 'New ERC-20 Mint Detected',
      color: 0x00ff00,
      fields: [
        { name: 'Contract Address', value: contractAddress, inline: true },
        { name: 'Token Name', value: metadata.name, inline: true },
        { name: 'Symbol', value: metadata.symbol, inline: true },
        { name: 'Icon', value: metadata.icon, inline: true },
        { name: 'Volume (USD)', value: metadata.volume.toString(), inline: true },
        { name: 'Minter', value: to, inline: true },
        { name: 'Minter Anonymity', value: anonymity, inline: true },
        { name: 'Amount Minted', value: ethers.utils.formatEther(value), inline: true },
        { name: 'Timestamp', value: new Date().toISOString(), inline: true },
      ],
    }],
  };
  try {
    await webhookClient.send(message);
    console.log(`Notification sent for mint at ${contractAddress}`);
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

// Main function to listen for mint events
async function listenForMints() {
  console.log('Starting ERC-20 mint listener...');
  console.log('Ethers version:', ethers.version);
  provider.on('block', async (blockNumber) => {
    try {
      const filter = { topics: [ethers.utils.id('Transfer(address,address,uint256)')] };
      const events = await provider.getLogs({ ...filter, fromBlock: blockNumber, toBlock: blockNumber });
      for (const event of events) {
        const { address: contractAddress, topics, data } = event;
        if (topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          const parsedEvent = ethers.utils.defaultAbiCoder.decode(['address', 'uint256'], ethers.utils.hexDataSlice(data, 0));
          const to = ethers.utils.getAddress('0x' + topics[2].slice(-40));
          const value = parsedEvent[1];
          await sendDiscordNotification({ contractAddress, to, value });
        }
      }
    } catch (error) {
      console.error('Error processing block:', error);
    }
  });
  provider.websocket.on('error', (error) => {
    console.error('WebSocket error:', error);
    setTimeout(listenForMints, 5000);
  });
}

// Start the listener
listenForMints().catch((error) => {
  console.error('Failed to start listener:', error);
  process.exit(1);
});