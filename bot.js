require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const GROUPS = JSON.parse(process.env.GROUPS);
const GROUP_IDS = GROUPS.map(group => group.id);
const GROUP_CHANNEL_IDS = GROUPS.map(group => group.channel);
let previousMembers = {};
let groupNames = {}; // Object to hold group names

async function sendWebhookLog(webhookUrl, title, description, color) {
    if (!webhookUrl) {
        console.error(`Webhook URL is not defined.`);
        return;
    }
    try {
        const embed = {
            embeds: [
                {
                    color: color === 'GREEN' ? 0x00FF00 : color === 'YELLOW' ? 0xFFFF00 : 0xFF0000,
                    title: title,
                    description: description,
                    timestamp: new Date().toISOString(),
                },
            ],
        };
        await axios.post(webhookUrl, embed);
    } catch (error) {
        console.error(`Failed to log message to Discord webhook:`, error.message);
    }
}

async function fetchGroupOwner(groupId) {
    const url = `https://groups.roblox.com/v1/groups/${groupId}`;
    try {
        const response = await axios.get(url);
        return response.data.owner || null;
    } catch (error) {
        console.error(`Error fetching owner for group ID ${groupId}:`, error.message);
        throw new Error(`Failed to fetch owner for group ID ${groupId}`);
    }
}

async function checkOwnerMembership(ownerId, targetGroupId, minRank) {
    const url = `https://groups.roblox.com/v1/users/${ownerId}/groups/roles`;
    try {
        const response = await axios.get(url);
        const targetGroup = response.data.data.find(group => group.group.id === targetGroupId);
        return targetGroup && targetGroup.role.rank >= minRank;
    } catch (error) {
        console.error(`Error checking membership for user ID ${ownerId}:`, error.message);
        throw new Error(`Failed to check membership for user ID ${ownerId}`);
    }
}

async function validateGroupOwner(groupId, targetGroupId, minRank, successWebhookUrl, failureWebhookUrl) {
    try {
        const owner = await fetchGroupOwner(groupId);
        if (!owner) throw new Error(`No owner found for group ID ${groupId}`);
        const isMember = await checkOwnerMembership(owner.userId, targetGroupId, minRank);
        const message = `
Group ID: [${groupId}](https://www.roblox.com/groups/${groupId})  
Owner: [${owner.username}](https://www.roblox.com/users/${owner.userId}/profile)  
Target Group ID: [${targetGroupId}](https://www.roblox.com/groups/${targetGroupId})  
Minimum Rank Required: ${minRank}  
Check Result: ${isMember ? "Passed" : "Failed"}
        `;
        await sendWebhookLog(
            isMember ? successWebhookUrl : failureWebhookUrl,
            "Group Owner Validation",
            message,
            isMember ? 'GREEN' : 'RED'
        );
        if (!isMember) throw new Error(`Owner does not meet the required rank for group ID ${groupId}.`);
    } catch (error) {
        await sendWebhookLog(failureWebhookUrl, "Validation Error", error.message, 'RED');
        process.exit(0); // Optionally exit on failure
    }
}

async function fetchGroupName(groupId) {
    try {
        const url = `https://groups.roblox.com/v1/groups/${groupId}`;
        const response = await axios.get(url);
        return response.data.name; // Return the group name
    } catch (error) {
        console.error(`Error fetching group name for group ID ${groupId}:`, error);
        return null; // Return null if there's an error
    }
}

function sendRolePing(discordChannelId, roleId) {
    const channel = client.channels.cache.get(discordChannelId);
    if (channel) {
        channel.send(`<@&${roleId}>`).catch(console.error);
    } else {
        console.log(`Channel with ID ${discordChannelId} not found.`);
    }
}

async function checkForChanges(groupId, discordChannelId, groupData) {
    try {
        if (!groupData) {
            console.error(`Missing group data for groupId ${groupId}.`);
            return;
        }
        const { MinimumRank, roleid } = groupData;
        if (!MinimumRank || !roleid) {
            console.error(`Group ${groupId} is missing MinimumRank or roleid.`);
            return;
        }
        console.log(`Fetching group members for group ID ${groupId}...`);
        let currentMembers = new Map();
        let cursor = null;
        let hasMorePages = true;

        while (hasMorePages) {
            const url = `https://groups.roblox.com/v1/groups/${groupId}/users${cursor ? `?cursor=${cursor}` : ''}`;
            const response = await axios.get(url);
            const members = response.data.data;

            members.forEach(member => {
                const username = member.user.username;
                const rankName = member.role.name;
                const rankNumber = member.role.rank;
                const userId = member.user.userId;

                if (!userId) {
                    console.error(`User ID is undefined for member: ${username}`);
                    return;
                }

                currentMembers.set(username, { rankName, rankNumber, userId });
                const profileLink = `https://www.roblox.com/users/${userId}/profile`;
                const groupName = groupNames[groupId];

                if (previousMembers[groupId]?.has(username)) {
                    const previousMember = previousMembers[groupId].get(username);

                    if (previousMember.rankNumber !== rankNumber) {
                        const oldRank = previousMember.rankName;

                        if (rankNumber > previousMember.rankNumber) {
                            const discordMessage = `
Player:     [${username}](${profileLink})
Group:      [${groupName}](https://www.roblox.com/groups/${groupId})
Old Rank:   ${oldRank}
New Rank:   ${rankName}`;
                            logToDiscord(discordChannelId, "Promotion", discordMessage, 'YELLOW');
                            if (rankNumber >= Number(MinimumRank)) {
                                sendRolePing(discordChannelId, roleid);
                            }
                        } else if (rankNumber < previousMember.rankNumber) {
                            const discordMessage = `
Player:     [${username}](${profileLink})
Group:      [${groupName}](https://www.roblox.com/groups/${groupId})
Old Rank:   ${oldRank}
New Rank:   ${rankName}`;
                            logToDiscord(discordChannelId, "Demotion", discordMessage, 8388736); // Purple color
                            if (rankNumber <= Number(MinimumRank) && previousMember.rankNumber > Number(MinimumRank)) {
                                sendRolePing(discordChannelId, roleid);
                            }
                        }
                    }
                } else {
                    const discordMessage = `
Player:     [${username}](${profileLink})
Group:      [${groupName}](https://www.roblox.com/groups/${groupId})
Rank:       ${rankName}`;
                    logToDiscord(discordChannelId, "Member Joined", discordMessage, 'GREEN');
                    if (rankNumber >= Number(MinimumRank)) {
                        sendRolePing(discordChannelId, roleid);
                    }
                }
            });

            cursor = response.data.nextPageCursor;
            hasMorePages = !!cursor;
            if (hasMorePages) await new Promise(resolve => setTimeout(resolve, 1000));
        }

        previousMembers[groupId] = currentMembers;
        saveCurrentMembers(groupId, currentMembers);
    } catch (error) {
        console.error('Error fetching group members:', error);
    }
}

function logToDiscord(discordChannelId, title, description, color) {
    const channel = client.channels.cache.get(discordChannelId);
    if (channel) {
        let embedColor;
        if (typeof color === 'string') {
            embedColor = color === 'GREEN' ? 0x00FF00 
                        : color === 'YELLOW' ? 0xFFFF00 
                        : color === 'RED' ? 0xFF0000 
                        : 0xFFFFFF;
        } else if (typeof color === 'number') {
            embedColor = color;
        } else {
            embedColor = 0xFFFFFF;
        }

        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(title)
            .setDescription(description)
            .setTimestamp(new Date());

        channel.send({ embeds: [embed] }).catch(console.error);
    } else {
        console.log(`Channel with ID ${discordChannelId} not found.`);
    }
}

function saveCurrentMembers(groupId, currentMembers) {
    const fileName = `groupMembers_${groupId}.json`;
    fs.writeFileSync(fileName, JSON.stringify(Array.from(currentMembers.entries()), null, 2));
}

async function handler(req, res) {
    // Set up bot event listeners
    client.once('ready', () => {
        console.log(`Logged in as ${client.user.tag}`);
    });

    client.on('messageCreate', (message) => {
        if (message.content === '!ping') {
            message.reply('Pong!');
        }
    });

    // Log the bot in
    client.login(process.env.DISCORD_TOKEN);

    res.status(200).send('Bot is up and running!');
}

// Export the handler function
module.exports = handler;
