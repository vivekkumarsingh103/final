export default function handler(req, res) {
  res.json({
    message: 'API is working!',
    timestamp: new Date().toISOString(),
    env: {
      mongodb: process.env.MONGODB_URI ? 'Set' : 'Missing',
      telegram: process.env.TELEGRAM_TOKEN ? 'Set' : 'Missing',
      admin: process.env.ADMIN_CHAT_ID ? 'Set' : 'Missing'
    }
  });
}
