/**
 * Cache Manager - Redis HASH Implementation (Node.js + ioredis)
 * 
 * Handles caching for: User, Room, Post, Family entities
 * Uses Redis HASH data structure for partial field updates
 * Works with ioredis library
 * 
 * @module CacheManager
 * @author Rockstar Team
 * @version 1.0
 */

const { redisClient } = require('../config/redis');
const mysql = require('../config/mysql');

class CacheManager {
    
    // ====================================
    // PROPERTIES
    // ====================================
    
    constructor() {
        this.redis = redisClient;
        this.defaultTTL = 14400; // 4 hours in seconds
        
        this.entityTTLs = {
            'user': 14400,   // 4 hours
            'room': 14400,   // 4 hours
            'post': 14400,   // 4 hours
            'family': 14400  // 4 hours
        };
        
        this.minTTLThreshold = 3600; // 1 hour
    }
    
    // ====================================
    // PUBLIC API - READ OPERATIONS
    // ====================================
    
    /**
     * Get entire entity (all HASH fields)
     * 
     * @param {string} entity - Entity type (user, room, post, family)
     * @param {number|string} id - Entity ID
     * @returns {Promise<Object|null>} Entity data or null if not found
     */
    async getSingle(entity, id) {
        const key = this.makeKey(entity, id);
        
        try {
            const data = await this.redis.hgetall(key); 
            
            if (!data || Object.keys(data).length === 0) {
                return null;
            }
            
            // Convert empty strings to null
            const converted = this.convertEmptyToNull(data);
            
            // Auto-check expiry for user entity
            if (entity === 'user') {
                return await this.checkUserExpiry(entity, id, converted);
            }
            
            return converted;
            
        } catch (error) {
            console.error('Redis getSingle error:', error.message);
            return null;
        }
    }
    
    /**
     * Get multiple entities (pipelined for performance)
     * 
     * @param {string} entity - Entity type
     * @param {Array<number|string>} ids - Array of entity IDs
     * @returns {Promise<Object>} Associative object {id: data}
     */
    async getMultiple(entity, ids) {
        if (!ids || ids.length === 0) {
            return {};
        }
        
        try {
            //Use ioredis pipeline (not multi)
            const pipeline = this.redis.pipeline();
            
            ids.forEach(id => {
                const key = this.makeKey(entity, id);
                pipeline.hgetall(key); 
            });
            
            const results = await pipeline.exec();
            
            // Build output object
            const output = {};
            
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                
                // ioredis pipeline returns [[error, result], ...]
                const [error, data] = results[i];
                
                if (!error && data && Object.keys(data).length > 0) {
                    const converted = this.convertEmptyToNull(data);
                    
                    // Check expiry for user entities
                    if (entity === 'user') {
                        output[id] = await this.checkUserExpiry(entity, id, converted);
                    } else {
                        output[id] = converted;
                    }
                }
            }
            
            return output;
            
        } catch (error) {
            console.error('Redis getMultiple error:', error.message);
            return {};
        }
    }
    
    /**
     * Get specific fields from entity
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {Array<string>} fieldNames - Array of field names to retrieve
     * @returns {Promise<Object|null>} Field values or null if entity not found
     */
    async getFields(entity, id, fieldNames) {
        if (!fieldNames || fieldNames.length === 0) {
            return null;
        }
        
        const key = this.makeKey(entity, id);
        
        try {
            // Check if key exists first
            const exists = await this.redis.exists(key); 
            if (!exists) {
                return null;
            }
            
            // ioredis hmget needs spread operator
            const values = await this.redis.hmget(key, ...fieldNames);
            
            // Combine field names with values
            const result = {};
            fieldNames.forEach((fieldName, index) => {
                result[fieldName] = values[index] !== null ? values[index] : null;
            });
            
            return this.convertEmptyToNull(result);
            
        } catch (error) {
            console.error('Redis getFields error:', error.message);
            return null;
        }
    }
    
    /**
     * Get single field value
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {string} fieldName - Field name
     * @returns {Promise<*>} Field value or null if not found
     */
    async getField(entity, id, fieldName) {
        const key = this.makeKey(entity, id);
        
        try {
            const value = await this.redis.hget(key, fieldName); 
            
            if (value === null || value === undefined) {
                return null;
            }
            
            return value === '' ? null : value;
            
        } catch (error) {
            console.error('Redis getField error:', error.message);
            return null;
        }
    }
    
    /**
     * Check if entity exists in cache
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @returns {Promise<boolean>} True if exists, false otherwise
     */
    async exists(entity, id) {
        const key = this.makeKey(entity, id);
        
        try {
            const exists = await this.redis.exists(key); 
            return exists > 0;
        } catch (error) {
            console.error('Redis exists error:', error.message);
            return false;
        }
    }
    
    // ====================================
    // PUBLIC API - WRITE OPERATIONS
    // ====================================
    
    /**
     * Store complete entity in cache (initial cache)
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {Object} data - Entity data (object)
     * @param {number|null} ttl - Time to live in seconds (optional)
     * @returns {Promise<boolean>} Success status
     */
    async cache(entity, id, data, ttl = null) {
        if (!data || Object.keys(data).length === 0) {
            return false;
        }
        
        const key = this.makeKey(entity, id);
        ttl = ttl ?? this.getEntityTTL(entity);
        
        try {
            // Convert null values to empty strings for HASH storage
            const converted = this.convertNullToEmpty(data);
            
            // ioredis hset accepts object directly
            await this.redis.hset(key, converted);
            
            // Set TTL
            await this.redis.expire(key, ttl); 
            
            return true;
            
        } catch (error) {
            console.error('Redis cache error:', error.message);
            return false;
        }
    }
    
    /**
     * Update specific fields in cached entity
     * If cache doesn't exist, fetches from DB first
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {Object} fields - Object of field => value pairs
     * @returns {Promise<boolean>} Success status
     */
    async updateFields(entity, id, fields) {
        if (!fields || Object.keys(fields).length === 0) {
            return false;
        }
        
        const key = this.makeKey(entity, id);
        
        try {
            // Check if cache exists
            const exists = await this.redis.exists(key); 
            
            if (!exists) {
                // Cache doesn't exist - fetch from DB first
                const fullData = await this.fetchFromDb(entity, id);
                
                if (!fullData) {
                    console.error(`Cannot update fields: Entity ${entity}:${id} not found in DB`);
                    return false;
                }
                
                // Cache the full entity first
                await this.cache(entity, id, fullData);
            }
            
            // Convert null values to empty strings
            const converted = this.convertNullToEmpty(fields);
            
            // Update specified fields
            await this.redis.hset(key, converted); 
            
            // Manage TTL
            await this.maintainTTL(key);
            
            return true;
            
        } catch (error) {
            console.error('Redis updateFields error:', error.message);
            return false;
        }
    }
    
    /**
     * Update single field in cached entity
     * If cache doesn't exist, fetches from DB first
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {string} fieldName - Field name
     * @param {*} value - Field value
     * @returns {Promise<boolean>} Success status
     */
    async updateField(entity, id, fieldName, value) {
        return await this.updateFields(entity, id, { [fieldName]: value });
    }
    
    // ====================================
    // PUBLIC API - COMBO OPERATIONS
    // ====================================
    
    /**
     * Get entity from cache or fetch from DB if not cached
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {number|null} ttl - Custom TTL (optional)
     * @returns {Promise<Object|null>} Entity data or null if not found
     */
    async getOrCache(entity, id, ttl = null) {
        // Try cache first
        const cached = await this.getSingle(entity, id);
        
        if (cached !== null) {
            return cached;
        }
        
        // Cache miss - fetch from DB
        const data = await this.fetchFromDb(entity, id);
        
        if (data) {
            await this.cache(entity, id, data, ttl);
        }
        
        return data;
    }
    
    /**
     * Get multiple entities from cache or fetch missing ones from DB
     * 
     * @param {string} entity - Entity type
     * @param {Array<number|string>} ids - Array of entity IDs
     * @param {number|null} ttl - Custom TTL (optional)
     * @returns {Promise<Object>} Associative object {id: data}
     */
    async getMultipleOrCache(entity, ids, ttl = null) {
        if (!ids || ids.length === 0) {
            return {};
        }
        
        // Get from cache (pipelined)
        const result = await this.getMultiple(entity, ids);
        
        // Find missing IDs
        const cachedIds = Object.keys(result).map(id => parseInt(id));
        const missing = ids.filter(id => !cachedIds.includes(parseInt(id)));
        
        if (missing.length > 0) {
            // Fetch missing from DB
            const dbData = await this.fetchMultipleFromDb(entity, missing);
            
            for (const item of dbData) {
                const itemId = this.getIdFromData(entity, item);
                
                // Cache it
                await this.cache(entity, itemId, item, ttl);
                
                // Add to result
                result[itemId] = item;
            }
        }
        
        return result;
    }
    
    // ====================================
    // PUBLIC API - UTILITY
    // ====================================
    
    /**
     * Get remaining TTL for cached entity
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @returns {Promise<number>} TTL in seconds, -1 if no expiry, -2 if not exists
     */
    async getTTL(entity, id) {
        const key = this.makeKey(entity, id);
        
        try {
            return await this.redis.ttl(key); 
        } catch (error) {
            console.error('Redis getTTL error:', error.message);
            return -2;
        }
    }
    
    /**
     * Refresh TTL without changing data
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @param {number|null} ttl - New TTL (optional, uses default if null)
     * @returns {Promise<boolean>} Success status
     */
    async touch(entity, id, ttl = null) {
        const key = this.makeKey(entity, id);
        ttl = ttl ?? this.getEntityTTL(entity);
        
        try {
            const exists = await this.redis.exists(key); 
            if (!exists) {
                return false;
            }
            
            await this.redis.expire(key, ttl); 
            return true;
            
        } catch (error) {
            console.error('Redis touch error:', error.message);
            return false;
        }
    }
    
    // ====================================
    // PRIVATE HELPERS - REDIS
    // ====================================
    
    /**
     * Make Redis key from entity and ID
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @returns {string} Redis key
     */
    makeKey(entity, id) {
        return `${entity}:${id}`;
    }
    
    /**
     * Get TTL for entity type
     * 
     * @param {string} entity - Entity type
     * @returns {number} TTL in seconds
     */
    getEntityTTL(entity) {
        return this.entityTTLs[entity] || this.defaultTTL;
    }
    
    /**
     * Maintain TTL on field update
     * Resets TTL if less than 1 hour remaining
     * 
     * @param {string} key - Redis key
     * @returns {Promise<void>}
     */
    async maintainTTL(key) {
        try {
            const currentTTL = await this.redis.ttl(key); 
            
            // If TTL < 1 hour, reset to default
            if (currentTTL > 0 && currentTTL < this.minTTLThreshold) {
                await this.redis.expire(key, this.defaultTTL); 
            }
            
        } catch (error) {
            console.error('Redis maintainTTL error:', error.message);
        }
    }
    
    // ====================================
    // PRIVATE HELPERS - DATA CONVERSION
    // ====================================
    
    /**
     * Convert null values to empty strings for HASH storage
     * 
     * @param {Object} data - Data object
     * @returns {Object} Converted data
     */
    convertNullToEmpty(data) {
        const converted = {};
        
        for (const [key, value] of Object.entries(data)) {
            converted[key] = value === null ? '' : value;
        }
        
        return converted;
    }
    
    /**
     * Convert empty strings to null when retrieving data
     * 
     * @param {Object} data - Data object
     * @returns {Object} Converted data
     */
    convertEmptyToNull(data) {
        const converted = {};
        
        for (const [key, value] of Object.entries(data)) {
            converted[key] = value === '' ? null : value;
        }
        
        return converted;
    }
    
    /**
     * Extract ID from data object based on entity type
     * 
     * @param {string} entity - Entity type
     * @param {Object} data - Data object
     * @returns {number|string} Entity ID
     */
    getIdFromData(entity, data) {
        switch (entity) {
            case 'user':
                return data.user_id || data.id;
            case 'room':
            case 'post':
            case 'family':
                return data.id;
            default:
                return data.id;
        }
    }
    
    // ====================================
    // PRIVATE HELPERS - EXPIRY CHECKING
    // ====================================
    
    /**
     * Check and update expired fields for user entity
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - User ID
     * @param {Object} data - User data
     * @returns {Promise<Object>} Updated user data
     */
    async checkUserExpiry(entity, id, data) {
        let updated = false;
        const fieldsToUpdate = {};
        
        // Check VIP expiry
        if (data.vip_end_at && data.isVip) {
            const vipEndTime = new Date(data.vip_end_at).getTime();
            if (vipEndTime < Date.now() && data.isVip == 1) {
                data.isVip = 0;
                fieldsToUpdate.isVip = 0;
                updated = true;
            }
        }
        
        // Check tag expiry
        if (data.tag_expired_at && data.tagUrl) {
            const tagExpTime = new Date(data.tag_expired_at).getTime();
            if (tagExpTime < Date.now()) {
                data.tagUrl = null;
                data.tag_expired_at = null;
                fieldsToUpdate.tagUrl = '';
                fieldsToUpdate.tag_expired_at = '';
                updated = true;
            }
        }
        
        // Check frame expiry
        if (data.frame_expired_at && data.frameUrl) {
            const frameExpTime = new Date(data.frame_expired_at).getTime();
            if (frameExpTime < Date.now()) {
                data.frameUrl = null;
                data.isAnimatedFrame = null;
                data.frame_expired_at = null;
                fieldsToUpdate.frameUrl = '';
                fieldsToUpdate.isAnimatedFrame = '';
                fieldsToUpdate.frame_expired_at = '';
                updated = true;
            }
        }
        
        // Update cache if any fields expired
        if (updated && Object.keys(fieldsToUpdate).length > 0) {
            try {
                const key = this.makeKey(entity, id);
                await this.redis.hset(key, fieldsToUpdate);
            } catch (error) {
                console.error('Redis checkUserExpiry update error:', error.message);
            }
        }
        
        return data;
    }
    
    // ====================================
    // DATABASE FETCH METHODS - ROUTING
    // ====================================
    
    /**
     * Route to appropriate fetch method based on entity
     * 
     * @param {string} entity - Entity type
     * @param {number|string} id - Entity ID
     * @returns {Promise<Object|null>} Entity data or null if not found
     */
    async fetchFromDb(entity, id) {
        switch (entity) {
            case 'user':
                return await this.fetchUserFromDb(id);
            case 'room':
                return await this.fetchRoomFromDb(id);
            case 'post':
                return await this.fetchPostFromDb(id);
            case 'family':
                return await this.fetchFamilyFromDb(id);
            default:
                console.error(`Unknown entity type: ${entity}`);
                return null;
        }
    }
    
    /**
     * Route to appropriate fetch multiple method based on entity
     * 
     * @param {string} entity - Entity type
     * @param {Array<number|string>} ids - Array of entity IDs
     * @returns {Promise<Array>} Array of entity data
     */
    async fetchMultipleFromDb(entity, ids) {
        switch (entity) {
            case 'user':
                return await this.fetchUsersFromDb(ids);
            case 'room':
                return await this.fetchRoomsFromDb(ids);
            case 'post':
                return await this.fetchPostsFromDb(ids);
            case 'family':
                return await this.fetchFamiliesFromDb(ids);
            default:
                console.error(`Unknown entity type: ${entity}`);
                return [];
        }
    }
    
    // ====================================
    // DATABASE FETCH - USER
    // ====================================
    
    /**
     * Fetch single user from database
     * 
     * @param {number} userId - User ID
     * @returns {Promise<Object|null>} User data or null if not found
     */
    async fetchUserFromDb(userId) {
        const sql = `
            SELECT 
                users.id as user_id,
                users.name,
                users.username,
                users.image,
                users.leval as user_level,
                users.verificationStatus,
                users.vip,
                users.isHidden,
                users.family,
                users.isNewUser,
                users.visitingTrace,
                users.newUserBenefitExpiry,
                users.blockEntryEffectPartyRoom,
                users.vipInvisible,
                users.privacyPrivilige,
                users.is_popular_singer,
                pret.tagImage as popular_singer_image,
                pret.tagChatBubble as popular_singer_chat_bubble,
                pret.tagEnrtyEffect as popular_singer_entry_effect,
                users.vipEndAt as vip_end_at,
                CASE WHEN users.vipEndAt > NOW() THEN 1 ELSE 0 END AS isVip,
                
                vip_wealth_rebate.tagUrl as vip_tag_url,
                vip_wealth_rebate.vipFrame as vip_frame,
                vip_wealth_rebate.profileCard as vip_profile_card,
                
                tag_data.tagUrl,
                tag_data.expiredAt as tag_expired_at,
                
                CASE 
                    WHEN users.vipEndAt > NOW() AND users.vipInvisible = 1 AND frame_data.vipStatus = 1 
                    THEN NULL 
                    ELSE frame_data.image 
                END AS frameUrl,
                frame_data.isAnimated as isAnimatedFrame,
                frame_data.expiredAt as frame_expired_at,
                frame_data.vipStatus as frame_vip_status,
                
                \`groups\`.familyTaillight,
                
                NOW() as cached_at
                
            FROM users
            LEFT JOIN vip_wealth_rebate ON users.vip = vip_wealth_rebate.level
            LEFT JOIN party_room_event_tags pret ON users.is_popular_singer = 1
            LEFT JOIN \`groups\` ON users.family = \`groups\`.id
            
            LEFT JOIN (
                SELECT ut.userId, utg.tagUrl, ut.expiredAt
                FROM user_tool ut
                INNER JOIN user_tags utg ON utg.id = ut.entityId
                INNER JOIN (
                    SELECT ut.userId, MAX(utg.priority) AS max_priority
                    FROM user_tool ut
                    INNER JOIN user_tags utg ON utg.id = ut.entityId
                    WHERE ut.entityType = 'tag' 
                      AND ut.isActive = 1 
                      AND ut.expiredAt > NOW()
                    GROUP BY ut.userId
                ) AS top_tag ON top_tag.userId = ut.userId AND utg.priority = top_tag.max_priority
                WHERE ut.entityType = 'tag' 
                  AND ut.isActive = 1 
                  AND ut.expiredAt > NOW()
                GROUP BY ut.userId
            ) AS tag_data ON tag_data.userId = users.id
            
            LEFT JOIN (
                SELECT ut.userId, fr.image, fr.isAnimated, ut.vipStatus, ut.expiredAt
                FROM user_tool ut
                INNER JOIN frames fr ON fr.id = ut.entityId
                WHERE ut.entityType = 'frame' 
                  AND ut.isActive = 1 
                  AND ut.expiredAt > NOW()
                LIMIT 1
            ) AS frame_data ON frame_data.userId = users.id
            
            WHERE users.id = ?
            LIMIT 1
        `;
        
        try {
            const rows = await mysql.query(sql, [userId]);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('fetchUserFromDb error:', error.message);
            return null;
        }
    }
    
    /**
     * Fetch multiple users from database
     * 
     * @param {Array<number>} userIds - Array of user IDs
     * @returns {Promise<Array>} Array of user data
     */
    async fetchUsersFromDb(userIds) {
        if (!userIds || userIds.length === 0) {
            return [];
        }
        
        const placeholders = userIds.map(() => '?').join(',');
        
        const sql = `
            SELECT 
                users.id as user_id,
                users.name,
                users.username,
                users.image,
                users.leval as user_level,
                users.verificationStatus,
                users.vip,
                users.family,
                users.isHidden,
                users.isNewUser,
                users.newUserBenefitExpiry,
                users.vipInvisible,
                users.visitingTrace,
                users.privacyPrivilige,
                users.vipEndAt as vip_end_at,
                users.is_popular_singer,
                pret.tagImage as popular_singer_image,
                pret.tagChatBubble as popular_singer_chat_bubble,
                pret.tagEnrtyEffect as popular_singer_entry_effect,
                CASE WHEN users.vipEndAt > NOW() THEN 1 ELSE 0 END AS isVip,
                
                vip_wealth_rebate.tagUrl as vip_tag_url,
                vip_wealth_rebate.vipFrame as vip_frame,
                vip_wealth_rebate.profileCard as vip_profile_card,
                
                tag_data.tagUrl,
                tag_data.expiredAt as tag_expired_at,
                
                CASE 
                    WHEN users.vipEndAt > NOW() AND users.vipInvisible = 1 AND frame_data.vipStatus = 1 
                    THEN NULL 
                    ELSE frame_data.image 
                END AS frameUrl,
                frame_data.isAnimated as isAnimatedFrame,
                frame_data.expiredAt as frame_expired_at,
                frame_data.vipStatus as frame_vip_status,
                
                \`groups\`.familyTaillight,
                
                NOW() as cached_at
                
            FROM users
            LEFT JOIN vip_wealth_rebate ON users.vip = vip_wealth_rebate.level
            LEFT JOIN party_room_event_tags pret ON users.is_popular_singer = 1
            LEFT JOIN \`groups\` ON users.family = \`groups\`.id
            
            LEFT JOIN (
                SELECT ut.userId, utg.tagUrl, ut.expiredAt
                FROM user_tool ut
                INNER JOIN user_tags utg ON utg.id = ut.entityId
                INNER JOIN (
                    SELECT ut.userId, MAX(utg.priority) AS max_priority
                    FROM user_tool ut
                    INNER JOIN user_tags utg ON utg.id = ut.entityId
                    WHERE ut.entityType = 'tag' 
                      AND ut.isActive = 1 
                      AND ut.expiredAt > NOW()
                    GROUP BY ut.userId
                ) AS top_tag ON top_tag.userId = ut.userId AND utg.priority = top_tag.max_priority
                WHERE ut.entityType = 'tag' 
                  AND ut.isActive = 1 
                  AND ut.expiredAt > NOW()
                GROUP BY ut.userId
            ) AS tag_data ON tag_data.userId = users.id
            
            LEFT JOIN (
                SELECT ut.userId, fr.image, fr.isAnimated, ut.vipStatus, ut.expiredAt
                FROM user_tool ut
                INNER JOIN frames fr ON fr.id = ut.entityId
                WHERE ut.entityType = 'frame' 
                  AND ut.isActive = 1 
                  AND ut.expiredAt > NOW()
            ) AS frame_data ON frame_data.userId = users.id
            
            WHERE users.id IN (${placeholders})
        `;
        
        try {
            const rows = await mysql.query(sql, userIds);
            return rows;
        } catch (error) {
            console.error('fetchUsersFromDb error:', error.message);
            return [];
        }
    }
    
    // ====================================
    // DATABASE FETCH - ROOM
    // ====================================
    
    /**
     * Fetch single party room from database
     * 
     * @param {number} roomId - Room ID
     * @returns {Promise<Object|null>} Room data or null if not found
     */
    async fetchRoomFromDb(roomId) {
        try {
            const rows = await mysql.query('SELECT * FROM party_rooms WHERE id = ?', [roomId]);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('fetchRoomFromDb error:', error.message);
            return null;
        }
    }
    
    /**
     * Fetch multiple party rooms from database
     * 
     * @param {Array<number>} roomIds - Array of room IDs
     * @returns {Promise<Array>} Array of room data
     */
    async fetchRoomsFromDb(roomIds) {
        if (!roomIds || roomIds.length === 0) {
            return [];
        }
        
        const placeholders = roomIds.map(() => '?').join(',');
        
        try {
            const rows = await mysql.query(
                `SELECT * FROM party_rooms WHERE id IN (${placeholders})`,
                roomIds
            );
            return rows;
        } catch (error) {
            console.error('fetchRoomsFromDb error:', error.message);
            return [];
        }
    }
    
    // ====================================
    // DATABASE FETCH - POST
    // ====================================
    
    /**
     * Fetch single post from database
     * 
     * @param {number} postId - Post ID
     * @returns {Promise<Object|null>} Post data or null if not found
     */
    async fetchPostFromDb(postId) {
        try {
            const rows = await mysql.query('SELECT * FROM post WHERE id = ?', [postId]);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('fetchPostFromDb error:', error.message);
            return null;
        }
    }
    
    /**
     * Fetch multiple posts from database
     * 
     * @param {Array<number>} postIds - Array of post IDs
     * @returns {Promise<Array>} Array of post data
     */
    async fetchPostsFromDb(postIds) {
        if (!postIds || postIds.length === 0) {
            return [];
        }
        
        const placeholders = postIds.map(() => '?').join(',');
        
        try {
            const rows = await mysql.query(
                `SELECT * FROM post WHERE id IN (${placeholders})`,
                postIds
            );
            return rows;
        } catch (error) {
            console.error('fetchPostsFromDb error:', error.message);
            return [];
        }
    }
    
    // ====================================
    // DATABASE FETCH - FAMILY
    // ====================================
    
    /**
     * Fetch single family from database
     * 
     * @param {number} familyId - Family ID
     * @returns {Promise<Object|null>} Family data or null if not found
     */
    async fetchFamilyFromDb(familyId) {
        try {
            const rows = await mysql.query('SELECT * FROM `groups` WHERE id = ?', [familyId]);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('fetchFamilyFromDb error:', error.message);
            return null;
        }
    }
    
    /**
     * Fetch multiple families from database
     * 
     * @param {Array<number>} familyIds - Array of family IDs
     * @returns {Promise<Array>} Array of family data
     */
    async fetchFamiliesFromDb(familyIds) {
        if (!familyIds || familyIds.length === 0) {
            return [];
        }
        
        const placeholders = familyIds.map(() => '?').join(',');
        
        try {
            const rows = await mysql.query(
                `SELECT * FROM \`groups\` WHERE id IN (${placeholders})`,
                familyIds
            );
            return rows;
        } catch (error) {
            console.error('fetchFamiliesFromDb error:', error.message);
            return [];
        }
    }
}

// Export singleton instance
module.exports = new CacheManager();