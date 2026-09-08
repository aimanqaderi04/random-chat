const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// =========================
// Einstellungen
// =========================

const BAN_DURATION = 2 * 60 * 60 * 1000; // 2 Stunden

const OLLAMA_URL =
    process.env.OLLAMA_URL ||
    'http://127.0.0.1:11434';

const OLLAMA_MODEL =
    process.env.OLLAMA_MODEL ||
    'llama3.2';

const AI_TIMEOUT = 30000;


// =========================
// Dateien / Datenbank
// =========================

const databaseDir =
    path.join(__dirname, 'database');

const databaseFile =
    path.join(databaseDir, 'chat-data.json');

const uploadsDir =
    path.join(__dirname, 'uploads');


if (!fs.existsSync(databaseDir)) {
    fs.mkdirSync(databaseDir, {
        recursive: true
    });
}

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, {
        recursive: true
    });
}


let database = {
    bans: {},
    blocks: {}
};


try {

    if (fs.existsSync(databaseFile)) {

        database = JSON.parse(
            fs.readFileSync(
                databaseFile,
                'utf8'
            )
        );

    }

} catch (error) {

    console.log(
        '⚠️ Datenbank konnte nicht gelesen werden:',
        error.message
    );

    database = {
        bans: {},
        blocks: {}
    };
}


if (!database.bans) {
    database.bans = {};
}

if (!database.blocks) {
    database.blocks = {};
}


function saveDatabase() {

    try {

        fs.writeFileSync(
            databaseFile,
            JSON.stringify(
                database,
                null,
                2
            ),
            'utf8'
        );

    } catch (error) {

        console.log(
            '❌ Datenbank konnte nicht gespeichert werden:',
            error.message
        );

    }

}


// =========================
// Express
// =========================

app.use(
    express.json({
        limit: '2mb'
    })
);

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(
    '/uploads',
    express.static(uploadsDir)
);

app.use(
    express.static(__dirname)
);


app.get('/', (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            'index.html'
        )
    );

});


// =========================
// Benutzer-ID
// =========================

function getDeviceId(socket) {

    const cookie =
        socket.handshake.headers.cookie || '';

    const match =
        cookie.match(
            /(?:^|;\s*)randomchat_user_id=([^;]+)/
        );


    if (match && match[1]) {

        return decodeURIComponent(
            match[1]
        );

    }


    return crypto.randomUUID();

}


// =========================
// Sperren
// =========================

function getBanInfo(deviceId) {

    const expiresAt =
        Number(
            database.bans[deviceId] || 0
        );


    if (!expiresAt) {

        return {
            banned: false,
            remaining: 0
        };

    }


    if (expiresAt <= Date.now()) {

        delete database.bans[deviceId];

        saveDatabase();

        return {
            banned: false,
            remaining: 0
        };

    }


    return {

        banned: true,

        remaining:
            expiresAt - Date.now(),

        expiresAt

    };

}


function banUser(deviceId) {

    const expiresAt =
        Date.now() + BAN_DURATION;


    database.bans[deviceId] =
        expiresAt;


    saveDatabase();


    return expiresAt;

}


// =========================
// Blockieren
// =========================

function blockUser(
    blockerId,
    blockedId
) {

    if (!database.blocks[blockerId]) {

        database.blocks[blockerId] = [];

    }


    if (
        !database.blocks[blockerId]
            .includes(blockedId)
    ) {

        database.blocks[blockerId]
            .push(blockedId);

        saveDatabase();

    }

}


function isBlocked(a, b) {

    return Boolean(

        database.blocks[a]
            ?.includes(b)

        ||

        database.blocks[b]
            ?.includes(a)

    );

}


// =========================
// Chat-Verwaltung
// =========================

const waitingUsers = [];

const rooms = new Map();

const socketUsers = new Map();


function updateOnlineUsers() {

    io.emit(
        'online users',
        io.engine.clientsCount
    );

}


function removeFromWaiting(socketId) {

    const index =
        waitingUsers.indexOf(
            socketId
        );


    if (index !== -1) {

        waitingUsers.splice(
            index,
            1
        );

    }

}


function getPartnerId(socketId) {

    const room =
        rooms.get(socketId);


    if (!room) {

        return null;

    }


    return room.users.find(
        id => id !== socketId
    ) || null;

}


function endRoom(
    socketId,
    reason = 'Chat beendet.'
) {

    const room =
        rooms.get(socketId);


    if (!room) {

        return;

    }


    for (
        const userId
        of room.users
    ) {

        rooms.delete(
            userId
        );


        const userSocket =
            io.sockets.sockets.get(
                userId
            );


        if (userSocket) {

            userSocket.data.inChat =
                false;


            userSocket.emit(
                'chat ended',
                {
                    reason
                }
            );

        }

    }

}


function cleanText(
    value,
    max = 2000
) {

    if (
        typeof value !==
        'string'
    ) {

        return '';

    }


    return value
        .trim()
        .slice(0, max);

}


// =========================
// KI-MODERATION
// =========================

async function moderateReport(
    messages,
    reason,
    reporterId
) {

    const transcript =
        messages.map(
            message => {

                const who =
                    message.senderId ===
                    reporterId

                    ? 'MELDENDER BENUTZER'

                    : 'GEMELDETER BENUTZER';


                return (
                    `${who}: ${message.text}`
                );

            }
        ).join('\n');


    const prompt = `Du bist ein Moderationssystem für einen anonymen 1-zu-1-Chat.

Prüfe eine Meldung anhand des Chatverlaufs und des angegebenen Meldegrundes.

Meldegrund:
${reason}

Chatverlauf:
${transcript || '(Kein Chatverlauf vorhanden)'}

Entscheide nur anhand der vorhandenen Informationen.

Eine Meldung ist JUSTIFIED, wenn der gemeldete Benutzer tatsächlich gegen normale Chat-Regeln verstößt, zum Beispiel durch schwere Beleidigungen, Drohungen, Belästigung oder eindeutig unzulässiges Verhalten.

Wenn die Meldung nicht ausreichend begründet ist, antworte NOT_JUSTIFIED.

Antworte ausschließlich mit genau einem Wort:

JUSTIFIED

oder

NOT_JUSTIFIED`;


    const controller =
        new AbortController();


    const timeout =
        setTimeout(
            () => controller.abort(),
            AI_TIMEOUT
        );


    try {

        const response =
            await fetch(
                `${OLLAMA_URL}/api/chat`,
                {

                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    signal:
                        controller.signal,

                    body:
                        JSON.stringify({

                            model:
                                OLLAMA_MODEL,

                            stream:
                                false,

                            messages: [

                                {
                                    role:
                                        'system',

                                    content:
                                        'Du bist ein strenges, neutrales Moderationssystem.'
                                },

                                {
                                    role:
                                        'user',

                                    content:
                                        prompt
                                }

                            ],

                            options: {
                                temperature: 0
                            }

                        })

                }
            );


        if (!response.ok) {

            throw new Error(
                `Ollama HTTP ${response.status}`
            );

        }


        const data =
            await response.json();


        const answer =
            String(
                data?.message?.content ||
                ''
            )
                .trim()
                .toUpperCase();


        if (
            answer.includes(
                'JUSTIFIED'
            )
            &&
            !answer.includes(
                'NOT_JUSTIFIED'
            )
        ) {

            return true;

        }


        if (
            answer.includes(
                'NOT_JUSTIFIED'
            )
        ) {

            return false;

        }


        return false;

    } finally {

        clearTimeout(
            timeout
        );

    }

}


// =========================
// Socket.IO
// =========================

io.on(
    'connection',
    socket => {

        const deviceId =
            getDeviceId(socket);


        socket.data.deviceId =
            deviceId;


        socket.data.inChat =
            false;


        socketUsers.set(
            socket.id,
            deviceId
        );


        console.log(
            '🟢 Verbindung:',
            socket.id
        );


        console.log(
            '🆔 Benutzer:',
            deviceId
        );


        updateOnlineUsers();


        const ban =
            getBanInfo(deviceId);


        if (ban.banned) {

            socket.emit(
                'user banned',
                {

                    remaining:
                        ban.remaining,

                    expiresAt:
                        ban.expiresAt

                }
            );

        }


        // =====================
        // Partner suchen
        // =====================

        socket.on(
            'find partner',
            () => {

                const currentBan =
                    getBanInfo(
                        deviceId
                    );


                if (
                    currentBan.banned
                ) {

                    socket.emit(
                        'user banned',
                        {

                            remaining:
                                currentBan.remaining,

                            expiresAt:
                                currentBan.expiresAt

                        }
                    );

                    return;

                }


                if (
                    socket.data.inChat
                ) {

                    return;

                }


                removeFromWaiting(
                    socket.id
                );


                for (
                    let i = 0;
                    i < waitingUsers.length;
                    i++
                ) {

                    const partnerId =
                        waitingUsers[i];


                    const partner =
                        io.sockets.sockets.get(
                            partnerId
                        );


                    if (
                        !partner ||
                        partner.id === socket.id ||
                        partner.data.inChat
                    ) {

                        waitingUsers.splice(
                            i,
                            1
                        );

                        i--;

                        continue;

                    }


                    const partnerBan =
                        getBanInfo(
                            partner.data.deviceId
                        );


                    if (
                        partnerBan.banned ||
                        isBlocked(
                            deviceId,
                            partner.data.deviceId
                        )
                    ) {

                        console.log(
                            '🚫 Partner übersprungen'
                        );

                        continue;

                    }


                    waitingUsers.splice(
                        i,
                        1
                    );


                    const room = {

                        users: [
                            socket.id,
                            partner.id
                        ],

                        messages: [],

                        reportInProgress:
                            false

                    };


                    rooms.set(
                        socket.id,
                        room
                    );


                    rooms.set(
                        partner.id,
                        room
                    );


                    socket.data.inChat =
                        true;


                    partner.data.inChat =
                        true;


                    socket.emit(
                        'partner found'
                    );


                    partner.emit(
                        'partner found'
                    );


                    console.log(
                        '💬 Chat:',
                        socket.id,
                        '<->',
                        partner.id
                    );


                    return;

                }


                waitingUsers.push(
                    socket.id
                );


                socket.emit(
                    'waiting'
                );


                console.log(
                    '⏳ Wartet:',
                    socket.id
                );

            }
        );


        // =====================
        // Nachricht
        // =====================

        socket.on(
            'chat message',
            data => {

                const room =
                    rooms.get(
                        socket.id
                    );


                if (
                    !room ||
                    room.reportInProgress
                ) {

                    return;

                }


                const text =
                    cleanText(
                        data?.text
                    );


                if (!text) {

                    return;

                }


                const partnerId =
                    getPartnerId(
                        socket.id
                    );


                if (!partnerId) {

                    return;

                }


                const message = {

                    senderId:
                        socket.id,

                    text,

                    time:
                        Date.now()

                };


                room.messages.push(
                    message
                );


                if (
                    room.messages.length >
                    100
                ) {

                    room.messages.shift();

                }


                const partner =
                    io.sockets.sockets.get(
                        partnerId
                    );


                if (partner) {

                    partner.emit(
                        'chat message',
                        {
                            text
                        }
                    );

                }

            }
        );


        // =====================
        // Tippen
        // =====================

        socket.on(
            'typing',
            isTyping => {

                const partnerId =
                    getPartnerId(
                        socket.id
                    );


                if (!partnerId) {

                    return;

                }


                const partner =
                    io.sockets.sockets.get(
                        partnerId
                    );


                if (partner) {

                    partner.emit(
                        'typing',
                        Boolean(
                            isTyping
                        )
                    );

                }

            }
        );


        // =====================
        // Melden
        // =====================

        socket.on(
            'report partner',
            async data => {

                const room =
                    rooms.get(
                        socket.id
                    );


                if (!room) {

                    return;

                }


                if (
                    room.reportInProgress
                ) {

                    return;

                }


                const partnerId =
                    getPartnerId(
                        socket.id
                    );


                const partner =
                    partnerId
                        ? io.sockets.sockets.get(
                            partnerId
                        )
                        : null;


                if (!partner) {

                    return;

                }


                const reason =
                    cleanText(
                        data?.reason,
                        500
                    )
                    ||
                    'Kein Grund angegeben';


                room.reportInProgress =
                    true;


                socket.emit(
                    'report checking'
                );


                console.log(
                    '🚩 Meldung:',
                    socket.id
                );


                console.log(
                    'Grund:',
                    reason
                );


                try {

                    const justified =
                        await moderateReport(
                            room.messages,
                            reason,
                            socket.id
                        );


                    if (!justified) {

                        room.reportInProgress =
                            false;


                        socket.emit(
                            'report rejected'
                        );


                        console.log(
                            '🤖 Meldung abgelehnt'
                        );


                        return;

                    }


                    const expiresAt =
                        banUser(
                            partner.data.deviceId
                        );


                    partner.emit(
                        'user banned',
                        {

                            remaining:
                                BAN_DURATION,

                            expiresAt

                        }
                    );


                    socket.emit(
                        'report saved'
                    );


                    socket.emit(
                        'report chat ended'
                    );


                    console.log(
                        '🤖 Meldung bestätigt'
                    );


                    endRoom(
                        socket.id,
                        'Die Meldung wurde bestätigt.'
                    );


                } catch (error) {

                    room.reportInProgress =
                        false;


                    console.log(
                        '❌ KI-Fehler:',
                        error.message
                    );


                    socket.emit(
                        'report error',
                        {

                            message:
                                'Die KI konnte die Meldung gerade nicht prüfen.'

                        }
                    );

                }

            }
        );


        // =====================
        // Partner blockieren
        // =====================

        socket.on(
            'block partner',
            () => {

                const partnerId =
                    getPartnerId(
                        socket.id
                    );


                if (!partnerId) {

                    return;

                }


                const partner =
                    io.sockets.sockets.get(
                        partnerId
                    );


                if (!partner) {

                    return;

                }


                blockUser(
                    deviceId,
                    partner.data.deviceId
                );


                socket.emit(
                    'partner blocked'
                );


                endRoom(
                    socket.id,
                    'Partner wurde blockiert.'
                );

            }
        );


        // =====================
        // Nächster Partner
        // =====================

        socket.on(
            'next partner',
            () => {

                endRoom(
                    socket.id,
                    'Chat beendet.'
                );


                socket.data.inChat =
                    false;

            }
        );


        // =====================
        // Chat verlassen
        // =====================

        socket.on(
            'leave chat',
            () => {

                endRoom(
                    socket.id,
                    'Chat verlassen.'
                );


                socket.data.inChat =
                    false;

            }
        );


        // =====================
        // Disconnect
        // =====================

        socket.on(
            'disconnect',
            () => {

                removeFromWaiting(
                    socket.id
                );


                endRoom(
                    socket.id,
                    'Verbindung getrennt.'
                );


                socketUsers.delete(
                    socket.id
                );


                updateOnlineUsers();


                console.log(
                    '🔴 Getrennt:',
                    socket.id
                );

            }
        );

    }
);


// =========================
// Server starten
// =========================

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '======================================'
        );

        console.log(
            `🚀 Server läuft auf http://localhost:${PORT}`
        );

        console.log(
            '💬 1-zu-1 Random Chat'
        );

        console.log(
            '🤖 KI-Moderation über Ollama'
        );

        console.log(
            '🚫 Sperre: 2 Stunden'
        );

        console.log(
            '======================================'
        );

    }
);