const { MongoClient } = require('mongodb');

// User states for post creation
const userStates = new Map();

export default async function handler(req, res) {
  // DEBUG: Log the request
  console.log('📨 Telegram webhook called');
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    console.log('🔄 Preflight request');
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    console.log('❌ Wrong method:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const update = req.body;
    console.log('📝 Update received:', JSON.stringify(update).substring(0, 200));
    
    // Send immediate response to Telegram (IMPORTANT!)
    res.status(200).json({ ok: true });
    
    // Process in background
    setTimeout(async () => {
      try {
        await handleTelegramUpdate(update);
      } catch (error) {
        console.error('❌ Error in background processing:', error);
      }
    }, 0);
    
  } catch (error) {
    console.error('❌ Main handler error:', error);
    // Still return 200 to Telegram
    res.status(200).json({ ok: true });
  }
}

// Connect to MongoDB
async function connectDB() {
  try {
    const uri = process.env.MONGODB_URI;
    console.log('🔗 Connecting to MongoDB...');
    
    if (!uri) {
      throw new Error('❌ MONGODB_URI not set');
    }
    
    const client = new MongoClient(uri);
    await client.connect();
    console.log('✅ MongoDB connected');
    return client.db('dramawallah');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
}

// Send message to Telegram
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    const token = process.env.TELEGRAM_TOKEN;
    
    if (!token) {
      console.error('❌ TELEGRAM_TOKEN not set');
      return;
    }
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    console.log(`📤 Sending message to ${chatId}: ${text.substring(0, 50)}...`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        ...options
      })
    });
    
    const result = await response.json();
    console.log('📨 Telegram API response:', result.ok ? '✅ Success' : '❌ Failed');
    return result;
    
  } catch (error) {
    console.error('❌ Error sending Telegram message:', error.message);
  }
}

// Handle Telegram updates
async function handleTelegramUpdate(update) {
  console.log('🔄 Processing update...');
  
  if (!update.message) {
    console.log('📭 No message in update');
    return;
  }
  
  const chatId = update.message.chat.id;
  const text = update.message.text || '';
  const userId = update.message.from.id;
  
  console.log(`👤 User ${userId}: "${text.substring(0, 50)}"`);
  
  // Check if user is admin
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) {
    console.error('❌ ADMIN_CHAT_ID not set');
    await sendTelegramMessage(chatId, '❌ Bot configuration error.');
    return;
  }
  
  if (userId.toString() !== adminId.toString()) {
    console.log(`🚫 Unauthorized user: ${userId}`);
    await sendTelegramMessage(chatId, '❌ You are not authorized to use this bot.');
    return;
  }
  
  // Handle photo message (accept image URLs for now)
  if (update.message.photo) {
    console.log('📸 Photo received');
    const state = userStates.get(chatId);
    if (state && state.step === 'awaiting_image') {
      // For now, ask for image URL instead of uploading
      await sendTelegramMessage(chatId,
        '📸 I received your photo! *For now, please send me an image URL instead.*\n\n' +
        'You can get image URLs from:\n' +
        '• https://unsplash.com\n' +
        '• https://imgur.com\n' +
        '• Any direct image link'
      );
      return;
    }
  }
  
  // Handle commands
  if (text.startsWith('/start')) {
    console.log('🚀 /start command');
    await sendWelcomeMessage(chatId);
    
  } else if (text.startsWith('/addpost')) {
    console.log('➕ /addpost command');
    await startAddPost(chatId);
    
  } else if (text.startsWith('/help')) {
    console.log('❓ /help command');
    await sendHelp(chatId);
    
  } else if (text.startsWith('/list')) {
    console.log('📋 /list command');
    await listPosts(chatId);
    
  } else if (text.startsWith('/test')) {
    console.log('🧪 /test command');
    await sendTelegramMessage(chatId, '✅ Bot is working!');
    
  } else {
    // Handle post creation flow
    await handlePostCreation(chatId, text);
  }
}

// Start post creation
async function startAddPost(chatId) {
  userStates.set(chatId, {
    step: 'awaiting_title',
    data: {}
  });
  
  console.log(`📝 Started post creation for ${chatId}`);
  
  await sendTelegramMessage(chatId,
    '📝 *CREATE NEW POST*\n\n' +
    'Step 1/4: Send me the **Post Title**:'
  );
}

// Handle post creation steps
async function handlePostCreation(chatId, text) {
  const state = userStates.get(chatId);
  if (!state) {
    console.log(`ℹ️ No active state for ${chatId}`);
    return;
  }
  
  console.log(`📝 Step ${state.step}: "${text.substring(0, 50)}"`);
  
  switch (state.step) {
    case 'awaiting_title':
      state.data.title = text;
      state.step = 'awaiting_image';
      await sendTelegramMessage(chatId,
        '✅ *Title saved!*\n\n' +
        'Step 2/4: Send me the **Image URL**:\n' +
        '(e.g., https://images.unsplash.com/photo-...)\n\n' +
        '*Note:* Direct photo upload coming soon!'
      );
      break;
      
    case 'awaiting_image':
      // Simple URL validation
      if (!text.startsWith('http')) {
        await sendTelegramMessage(chatId,
          '❌ Please send a valid image URL starting with http:// or https://'
        );
        return;
      }
      
      state.data.image = text;
      state.step = 'awaiting_description';
      await sendTelegramMessage(chatId,
        '✅ *Image URL saved!*\n\n' +
        'Step 3/4: Send me the **Description**:'
      );
      break;
      
    case 'awaiting_description':
      state.data.description = text;
      state.step = 'awaiting_link';
      await sendTelegramMessage(chatId,
        '✅ *Description saved!*\n\n' +
        'Step 4/4: Send me the **Redirect Link**:\n' +
        '(Users will click on title to visit this link)'
      );
      break;
      
    case 'awaiting_link':
      if (!text.startsWith('http')) {
        await sendTelegramMessage(chatId,
          '❌ Please send a valid URL starting with http:// or https://'
        );
        return;
      }
      
      state.data.link = text;
      state.data.category = 'news';
      state.data.createdAt = new Date().toISOString();
      
      console.log('💾 Saving post to database...');
      await savePostToDatabase(state.data, chatId);
      userStates.delete(chatId);
      break;
      
    default:
      console.log(`❓ Unknown step: ${state.step}`);
      userStates.delete(chatId);
  }
}

// Save post to database
async function savePostToDatabase(postData, chatId) {
  try {
    const db = await connectDB();
    const posts = db.collection('posts');
    
    const post = {
      title: postData.title,
      image: postData.image,
      description: postData.description,
      link: postData.link,
      category: postData.category || 'news',
      createdAt: new Date().toISOString(),
      views: 0,
      source: 'telegram_bot'
    };
    
    console.log('📊 Saving post:', post.title);
    const result = await posts.insertOne(post);
    console.log('✅ Post saved with ID:', result.insertedId);
    
    await sendTelegramMessage(chatId,
      `🎉 *POST CREATED SUCCESSFULLY!*\n\n` +
      `*Title:* ${post.title}\n` +
      `*Link:* ${post.link}\n` +
      `*Category:* ${post.category}\n\n` +
      `✅ Post is now live on your website!\n` +
      `🔗 https://dramawallah.vercel.app`
    );
    
  } catch (error) {
    console.error('❌ Database error:', error);
    await sendTelegramMessage(chatId,
      '❌ *Error saving post!*\n\n' +
      'Please check:\n' +
      '1. MongoDB connection\n' +
      '2. Environment variables\n' +
      '3. Try again later'
    );
  }
}

// List all posts
async function listPosts(chatId) {
  try {
    const db = await connectDB();
    const posts = db.collection('posts');
    const allPosts = await posts.find({}).sort({ createdAt: -1 }).toArray();
    
    if (allPosts.length === 0) {
      await sendTelegramMessage(chatId, '📭 *No posts found.*\n\nAdd your first post with /addpost');
      return;
    }
    
    let message = `📋 *TOTAL POSTS: ${allPosts.length}*\n\n`;
    
    allPosts.forEach((post, index) => {
      const date = new Date(post.createdAt).toLocaleDateString();
      message += `${index + 1}. *${post.title}*\n`;
      message += `   📅 ${date} | 📂 ${post.category}\n`;
      message += `   🔗 ${post.link}\n\n`;
    });
    
    await sendTelegramMessage(chatId, message);
    
  } catch (error) {
    console.error('❌ Error listing posts:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching posts from database.');
  }
}

// Welcome message
async function sendWelcomeMessage(chatId) {
  const welcome = `
🤖 *WELCOME TO DRAMABOT!*

*I can help you manage your Dramawallah website.*

✅ *Commands:*
/addpost - Create new post
/list - Show all posts
/help - Show help
/test - Test bot connection

✅ *How to add a post:*
1. Send /addpost
2. Send title
3. Send image URL
4. Send description
5. Send redirect link

✅ *Website:* https://dramawallah.vercel.app

*Bot is connected and ready!* 🚀
  `;
  
  await sendTelegramMessage(chatId, welcome);
}

// Help message
async function sendHelp(chatId) {
  const help = `
📚 *DRAMABOT HELP*

*Getting Started:*
1. Use /addpost to create content
2. Follow the step-by-step prompts
3. Posts appear instantly on website

*Image URLs:*
• https://images.unsplash.com/...
• https://i.imgur.com/...
• Any direct image link

*Example Workflow:*
1. /addpost
2. "Winter Wardrobe Secrets"
3. "https://images.unsplash.com/photo-..."
4. "Behind the scenes of winter costumes"
5. "https://yourblog.com/article"

*Need Help?*
Check Vercel logs or contact support.

*Bot Status:* ✅ Online
  `;
  
  await sendTelegramMessage(chatId, help);
}
