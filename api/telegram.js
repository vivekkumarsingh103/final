
const { MongoClient } = require('mongodb');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// User states for post creation
const userStates = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const update = req.body;
    await handleTelegramUpdate(update);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Connect to MongoDB
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  const client = new MongoClient(uri);
  await client.connect();
  return client.db('dramawallah');
}

// Send message to Telegram
async function sendTelegramMessage(chatId, text, options = {}) {
  const token = process.env.TELEGRAM_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
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
  
  return response.json();
}

// Handle Telegram updates
async function handleTelegramUpdate(update) {
  // Handle photo message
  if (update.message && update.message.photo) {
    const chatId = update.message.chat.id;
    const state = userStates.get(chatId);
    
    if (state && state.step === 'awaiting_image') {
      await handlePhotoUpload(chatId, update.message.photo, state);
      return;
    }
  }
  
  if (!update.message) return;
  
  const chatId = update.message.chat.id;
  const text = update.message.text || '';
  const userId = update.message.from.id;
  
  // Check admin
  if (userId.toString() !== process.env.ADMIN_CHAT_ID) {
    await sendTelegramMessage(chatId, '❌ You are not authorized.');
    return;
  }
  
  // Handle commands
  if (text.startsWith('/start')) {
    await sendWelcome(chatId);
  } else if (text.startsWith('/addpost')) {
    await startAddPost(chatId);
  } else if (text.startsWith('/help')) {
    await sendHelp(chatId);
  } else if (text.startsWith('/list')) {
    await listPosts(chatId);
  } else {
    await handleTextInput(chatId, text);
  }
}

// Start post creation
async function startAddPost(chatId) {
  userStates.set(chatId, {
    step: 'awaiting_title',
    data: {}
  });
  
  await sendTelegramMessage(chatId,
    '📝 *Create New Post*\n\n' +
    'Step 1/3: Send me the **Post Title**:'
  );
}

// Handle text inputs
async function handleTextInput(chatId, text) {
  const state = userStates.get(chatId);
  if (!state) return;
  
  switch (state.step) {
    case 'awaiting_title':
      state.data.title = text;
      state.step = 'awaiting_image';
      await sendTelegramMessage(chatId,
        '✅ Title saved!\n\n' +
        'Step 2/3: Now **send me a photo** for this post:\n' +
        '(Upload any image directly to Telegram)'
      );
      break;
      
    case 'awaiting_description':
      state.data.description = text;
      state.step = 'awaiting_link';
      await sendTelegramMessage(chatId,
        '✅ Description saved!\n\n' +
        'Step 3/3: Send me the **Redirect Link**:\n' +
        '(Where users go when they click the title)'
      );
      break;
      
    case 'awaiting_link':
      state.data.link = text;
      state.data.category = 'news';
      state.data.createdAt = new Date().toISOString();
      
      await savePostToDatabase(state.data, chatId);
      userStates.delete(chatId);
      break;
  }
}

// Handle photo upload
async function handlePhotoUpload(chatId, photos, state) {
  try {
    // Get the largest photo (last in array)
    const largestPhoto = photos[photos.length - 1];
    const fileId = largestPhoto.file_id;
    
    await sendTelegramMessage(chatId, '📸 Photo received! Processing...');
    
    // Get file path from Telegram
    const token = process.env.TELEGRAM_TOKEN;
    const fileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
    const fileResponse = await fetch(fileUrl);
    const fileData = await fileResponse.json();
    
    if (!fileData.ok) throw new Error('Failed to get file');
    
    const filePath = fileData.result.file_path;
    const telegramFileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    
    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(telegramFileUrl, {
      folder: 'dramawallah',
      transformation: [
        { width: 1000, height: 600, crop: 'fill' },
        { quality: 'auto:good' }
      ]
    });
    
    state.data.image = uploadResult.secure_url;
    state.step = 'awaiting_description';
    
    await sendTelegramMessage(chatId,
      '✅ Image uploaded successfully!\n\n' +
      'Now send me the **Description** for this post:'
    );
    
  } catch (error) {
    console.error('Upload error:', error);
    await sendTelegramMessage(chatId, '❌ Failed to upload image. Please try again.');
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
      category: postData.category,
      createdAt: new Date().toISOString(),
      views: 0,
      source: 'telegram_bot'
    };
    
    await posts.insertOne(post);
    
    await sendTelegramMessage(chatId,
      `🎉 *Post Created Successfully!*\n\n` +
      `*Title:* ${post.title}\n` +
      `*Image:* ✅ Uploaded\n` +
      `*Link:* ${post.link}\n\n` +
      `Your post is now live on the website!`
    );
    
    console.log('Post saved:', post.title);
    
  } catch (error) {
    console.error('Database error:', error);
    await sendTelegramMessage(chatId, '❌ Error saving post to database.');
  }
}

// List posts
async function listPosts(chatId) {
  try {
    const db = await connectDB();
    const posts = db.collection('posts');
    const allPosts = await posts.find({}).sort({ createdAt: -1 }).toArray();
    
    if (allPosts.length === 0) {
      await sendTelegramMessage(chatId, '📭 No posts found.');
      return;
    }
    
    let message = `📋 *Total Posts: ${allPosts.length}*\n\n`;
    
    allPosts.forEach((post, index) => {
      const date = new Date(post.createdAt).toLocaleDateString();
      message += `${index + 1}. *${post.title}*\n`;
      message += `   📅 ${date}\n`;
      message += `   🔗 ${post.link}\n\n`;
    });
    
    await sendTelegramMessage(chatId, message);
    
  } catch (error) {
    console.error('Error:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching posts.');
  }
}

// Welcome message
async function sendWelcome(chatId) {
  const welcome = `
🤖 *Welcome to DramaBot!*

*With Image Upload Feature:*

1. */addpost* - Create new post with photo upload
2. */list* - Show all posts
3. */help* - Show help

*How to add a post:*
1. Send /addpost
2. Send title
3. **Upload photo** (directly in Telegram)
4. Send description
5. Send link

*No more image links needed!*
  `;
  
  await sendTelegramMessage(chatId, welcome);
}

// Help message
async function sendHelp(chatId) {
  const help = `
📚 *DramaBot Help*

*Upload Photos Directly:*
• Just send any photo when asked for image
• Supports JPG, PNG, GIF
• Auto-resized for website

*Commands:*
/addpost - Create post with photo upload
/list - View all posts
/help - This message

*Example Workflow:*
1. /addpost
2. "Winter Wardrobe Secrets"
3. 📸 [Upload photo]
4. "Behind the scenes of winter costumes"
5. "https://example.com/article"

*Need help?* Contact support.
  `;
  
  await sendTelegramMessage(chatId, help);
}
