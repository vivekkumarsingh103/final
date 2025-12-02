const { MongoClient } = require('mongodb');

let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb) {
        return cachedDb;
    }
    
    const uri = process.env.MONGODB_URI;
    const client = new MongoClient(uri);
    
    await client.connect();
    const db = client.db('dramawallah');
    
    cachedDb = db;
    return db;
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        const db = await connectToDatabase();
        const postsCollection = db.collection('posts');
        
        switch (req.method) {
            case 'GET':
                const posts = await postsCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .toArray();
                res.status(200).json(posts);
                break;
                
            case 'POST':
                const post = {
                    ...req.body,
                    createdAt: new Date().toISOString(),
                    views: 0,
                    likes: 0,
                    status: 'published'
                };
                
                // Validate required fields
                if (!post.title || !post.image || !post.description || !post.link) {
                    return res.status(400).json({ 
                        error: 'Missing required fields: title, image, description, link' 
                    });
                }
                
                const result = await postsCollection.insertOne(post);
                post._id = result.insertedId;
                res.status(201).json(post);
                break;
                
            case 'DELETE':
                const deleteResult = await postsCollection.deleteMany({});
                res.status(200).json({ 
                    deletedCount: deleteResult.deletedCount,
                    message: 'All posts deleted successfully' 
                });
                break;
                
            default:
                res.status(405).json({ error: 'Method not allowed' });
        }
        
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
