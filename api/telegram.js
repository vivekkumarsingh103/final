const { MongoClient } = require('mongodb');

// User states for post creation
const userStates = new Map();

export default async function handler(req, res) {
  console.log('📨 Telegram webhook called at:', new Date().toISOString());
  
  // Set CORS headers
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
    
    // Send IMMEDIATE response to Telegram (CRITICAL!)
    res.status(200).json({ ok: true });
    
    // Process in background (async)
    processUpdateAsync(update).catch(error => {
      console.error('❌ Background processing error:', error.message);
    });
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    // Still return 200 to prevent Telegram retries
    res.status(200).json({ ok: true });
  }
}

// Process update in background (doesn't block response)
async function processUpdateAsync(update) {
  try {
    console.log('🔄 Processing update in background...');
    await handleTelegramUpdate(update);
  } catch (error) {
    console.error('❌ Update processing failed:', error.message);
  }
}

// Connect to MongoDB with timeout
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  console.log('🔗 Connecting to MongoDB...');
  
  if (!uri) {
    throw new Error('❌ MONGODB_URI not set');
  }
  
  // Add timeout to prevent hanging
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('MongoDB connection timeout')), 5000);
  });
  
  const client = new MongoClient(uri);
  
  // Race between connection and timeout
  await Promise.race([
    client.connect(),
    timeoutPromise
  ]);
  
  console.log('✅ MongoDB connected');
  return client.db('dramawallah');
}

// Send message to Telegram with retry
async function sendTelegramMessage(chatId, text, options = {}) {
  const token = process.env.TELEGRAM_TOKEN;
  
  if (!token) {
    console.error('❌ TELEGRAM_TOKEN not set');
    return;
  }
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    ...options
  };
  
  // Retry logic
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`📤 Sending message to ${chatId} (attempt ${attempt})`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        console.log('✅ Message sent successfully');
        return await response.json();
      }
      
      console.log(`⚠️ Attempt ${attempt} failed: ${response.status}`);
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} error:`, error.message);
    }
    
    // Wait before retry (except on last attempt)
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.error('❌ Failed to send message after 3 attempts');
}

// Handle Telegram updates
async function handleTelegramUpdate(update) {
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
  
  // Handle commands with immediate response
  if (text.startsWith('/start')) {
    await sendWelcomeMessage(chatId);
    
  } else if (text.startsWith('/addpost')) {
    await startAddPost(chatId);
    
  } else if (text.startsWith('/help')) {
    await sendHelp(chatId);
    
  } else if (text.startsWith('/list')) {
    await listPosts(chatId);
    
  } else if (text.startsWith('/clear')) {
    await clearPosts(chatId);
    
  } else if (text.startsWith('/test')) {
    await sendTelegramMessage(chatId, '✅ Bot is working! Response time optimized.');
    
  } else {
    await handlePostCreation(chatId, text);
  }
}

// Start post creation
async function startAddPost(chatId) {
  userStates.set(chatId, {
    step: 'awaiting_title',
    data: {},
    timestamp: Date.now()
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
  
  // Clean old states (older than 10 minutes)
  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    userStates.delete(chatId);
    await sendTelegramMessage(chatId, '⏱️ Session expired. Please start over with /addpost');
    return;
  }
  
  console.log(`📝 Step ${state.step}: "${text.substring(0, 50)}"`);
  
  switch (state.step) {
    case 'awaiting_title':
      state.data.title = text;
      state.step = 'awaiting_image';
      state.timestamp = Date.now();
      await sendTelegramMessage(chatId,
        '✅ *Title saved!*\n\n' +
        'Step 2/4: Send me the **Image URL**:\n' +
        '(e.g., https://images.unsplash.com/photo-...)\n\n' +
        '*Tip:* Use direct image links from Unsplash or Imgur'
      );
      break;
      
    case 'awaiting_image':
      // Basic URL validation
      if (!text.startsWith('http')) {
        await sendTelegramMessage(chatId,
          '❌ Please send a valid image URL starting with http:// or https://\n' +
          'Example: https://images.unsplash.com/photo-1542856391-010b89d4baf4'
        );
        return;
      }
      
      state.data.image = text;
      state.step = 'awaiting_description';
      state.timestamp = Date.now();
      await sendTelegramMessage(chatId,
        '✅ *Image URL saved!*\n\n' +
        'Step 3/4: Send me the **Description**:'
      );
      break;
      
    case 'awaiting_description':
      state.data.description = text;
      state.step = 'awaiting_link';
      state.timestamp = Date.now();
      await sendTelegramMessage(chatId,
        '✅ *Description saved!*\n\n' +
        'Step 4/4: Send me the **Redirect Link**:\n' +
        '(Users will click on title to visit this link)\n\n' +
        '*Important:* This should be a webpage URL, not an image URL!'
      );
      break;
      
    case 'awaiting_link':
      if (!text.startsWith('http')) {
        await sendTelegramMessage(chatId,
          '❌ Please send a valid URL starting with http:// or https://\n' +
          'Example: https://dramawallah.vercel.app'
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

// Save post to database with timeout
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
      `*Description:* ${post.description.substring(0, 50)}...\n` +
      `*Link:* ${post.link}\n` +
      `*Category:* ${post.category}\n\n` +
      `✅ Post is now live on your website!\n` +
      `🔗 https://dramawallah.vercel.app\n\n` +
      `*Next:* Check your website to see it appear instantly!`
    );
    
  } catch (error) {
    console.error('❌ Database error:', error.message);
    await sendTelegramMessage(chatId,
      '❌ *Error saving post!*\n\n' +
      'The post was not saved. Please try again.\n' +
      'Error: ' + error.message
    );
  }
}

// List posts with timeout protection
async function listPosts(chatId) {
  try {
    console.log('📊 Fetching posts from MongoDB...');
    
    // Add timeout for database query
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Database query timeout')), 3000);
    });
    
    const db = await connectDB();
    const posts = db.collection('posts');
    
    const queryPromise = posts.find({}).sort({ createdAt: -1 }).toArray();
    const allPosts = await Promise.race([queryPromise, timeoutPromise]);
    
    console.log(`✅ Found ${allPosts.length} posts`);
    
    if (allPosts.length === 0) {
      await sendTelegramMessage(chatId, '📭 *No posts found.*\n\nAdd your first post with /addpost');
      return;
    }
    
    let message = `📋 *TOTAL POSTS: ${allPosts.length}*\n\n`;
    
    allPosts.forEach((post, index) => {
      const date = new Date(post.createdAt).toLocaleDateString();
      message += `${index + 1}. *${post.title}*\n`;
      message += `   📅 ${date} | 📂 ${post.category || 'news'}\n`;
      message += `   🔗 ${post.link}\n`;
      message += `   📝 ${post.description ? post.description.substring(0, 50) + '...' : 'No description'}\n\n`;
    });
    
    await sendTelegramMessage(chatId, message);
    
  } catch (error) {
    console.error('❌ Error listing posts:', error.message);
    await sendTelegramMessage(chatId,
      '⚠️ *Could not fetch posts*\n\n' +
      'The posts are saved but listing failed.\n' +
      'Check your website to see all posts.\n\n' +
      'Error: ' + error.message
    );
  }
}

// Clear all posts
async function clearPosts(chatId) {
  try {
    const db = await connectDB();
    const posts = db.collection('posts');
    const result = await posts.deleteMany({});
    
    await sendTelegramMessage(chatId,
      `🗑️ *Cleared ${result.deletedCount} posts*\n\n` +
      `All posts have been removed from the website.`
    );
    
  } catch (error) {
    console.error('❌ Error clearing posts:', error);
    await sendTelegramMessage(chatId, '❌ Error clearing posts.');
  }
}

// Welcome message
async function sendWelcomeMessage(chatId) {
  const welcome = `
🤖 *WELCOME TO DRAMABOT!* 🚀

*I can help you manage your Dramawallah website instantly!*

✅ *Commands:*
/addpost - Create new post (4 simple steps)
/list - Show all posts (fast response)
/help - Show help
/clear - Remove all posts
/test - Test bot speed

✅ *How to add a post:*
1. Send /addpost
2. Send title
3. Send image URL
4. Send description
5. Send redirect link

✅ *Website:* https://dramawallah.vercel.app

*Bot is optimized for speed!* ⚡
  `;
  
  await sendTelegramMessage(chatId, welcome);
}

// Help message
async function sendHelp(chatId) {
  const help = `
📚 *DRAMABOT HELP - OPTIMIZED* ⚡

*Getting Started:*
1. Use /addpost to create content
2. Follow the step-by-step prompts
3. Posts appear instantly on website

*Image URLs (direct links only):*
• https://images.unsplash.com/photo-...
• https://i.imgur.com/...
• https://picsum.photos/...

*Redirect Links (webpage URLs):*
• https://dramawallah.vercel.app
• https://your-blog.com/article
• Any valid webpage URL

*Example Workflow:*
1. /addpost
2. "Winter Wardrobe Secrets"
3. "https://images.unsplash.com/photo-1542856391-010b89d4baf4"
4. "Behind the scenes of winter costumes"
5. "https://dramawallah.vercel.app/winter-wardrobe"

*Bot Status:* ✅ Online & Optimized
*Response Time:* ⚡ Fast
  `;
  
  await sendTelegramMessage(chatId, help);
}
