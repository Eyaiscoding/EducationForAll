const express = require('express')
const { Server } = require('socket.io')
const http = require('http')
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken')
const UserModel = require('../models/UserModel')
const { ConversationModel, MessageModel } = require('../models/ConversationModel')
const getConversation = require('../helpers/getConversation')

const app = express()

/*** Socket connection */
const server = http.createServer(app)
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        credentials: true
    }
})

/*** Socket running at http://localhost:8080/ */

// Online user set
const onlineUser = new Set()

io.on('connection', async (socket) => {
    console.log("Connect User", socket.id)

    try {
        const token = socket.handshake.auth.token
        const user = await getUserDetailsFromToken(token)

        if (user && user._id) {
            socket.join(user._id.toString())
            onlineUser.add(user._id.toString())
            io.emit('onlineUser', Array.from(onlineUser))
        } else {
            console.warn('User or user ID is undefined')
        }

        // Listen for 'message-page' event
        socket.on('message-page', async (userId) => {
            if (!user || !user._id) return

            const userDetails = await UserModel.findById(userId).select("-password")
            const payload = {
                _id: userDetails?._id,
                name: userDetails?.name,
                email: userDetails?.email,
                profile_pic: userDetails?.profile_pic,
                online: onlineUser.has(userId)
            }
            socket.emit('message-user', payload)

            const getConversationMessage = await ConversationModel.findOne({
                "$or": [
                    { sender: user._id, receiver: userId },
                    { sender: userId, receiver: user._id }
                ]
            }).populate('messages').sort({ updatedAt: -1 })

            socket.emit('message', getConversationMessage?.messages || [])
        })

        // New message
        socket.on('new message', async (data) => {
            let conversation = await ConversationModel.findOne({
                "$or": [
                    { sender: data?.sender, receiver: data?.receiver },
                    { sender: data?.receiver, receiver: data?.sender }
                ]
            })

            if (!conversation) {
                const createConversation = await ConversationModel({
                    sender: data?.sender,
                    receiver: data?.receiver
                })
                conversation = await createConversation.save()
            }

            const message = new MessageModel({
                text: data.text,
                imageUrl: data.imageUrl,
                videoUrl: data.videoUrl,
                msgByUserId: data?.msgByUserId,
            })
            const saveMessage = await message.save()

            await ConversationModel.updateOne({ _id: conversation._id }, {
                "$push": { messages: saveMessage._id }
            })

            const getConversationMessage = await ConversationModel.findOne({
                "$or": [
                    { sender: data?.sender, receiver: data?.receiver },
                    { sender: data?.receiver, receiver: data?.sender }
                ]
            }).populate('messages').sort({ updatedAt: -1 })

            io.to(data.sender).emit('message', getConversationMessage?.messages || [])
            io.to(data.receiver).emit('message', getConversationMessage?.messages || [])

            const conversationSender = await getConversation(data.sender)
            const conversationReceiver = await getConversation(data.receiver)

            io.to(data.sender).emit('conversation', conversationSender)
            io.to(data.receiver).emit('conversation', conversationReceiver)
        })

        // Sidebar
        socket.on('sidebar', async (currentUserId) => {
            const conversation = await getConversation(currentUserId)
            socket.emit('conversation', conversation)
        })

        // Seen
        socket.on('seen', async (msgByUserId) => {
            if (!user || !user._id) return

            const conversation = await ConversationModel.findOne({
                "$or": [
                    { sender: user._id, receiver: msgByUserId },
                    { sender: msgByUserId, receiver: user._id }
                ]
            })

            const conversationMessageId = conversation?.messages || []
            await MessageModel.updateMany(
                { _id: { "$in": conversationMessageId }, msgByUserId: msgByUserId },
                { "$set": { seen: true } }
            )

            const conversationSender = await getConversation(user._id.toString())
            const conversationReceiver = await getConversation(msgByUserId)

            io.to(user._id.toString()).emit('conversation', conversationSender)
            io.to(msgByUserId).emit('conversation', conversationReceiver)
        })

        // Disconnect
        socket.on('disconnect', () => {
            if (user && user._id) {
                onlineUser.delete(user._id.toString())
            }
            console.log('Disconnect user', socket.id)
        })

    } catch (error) {
        console.error('Error handling socket connection:', error)
    }
})

module.exports = {
    app,
    server
}
