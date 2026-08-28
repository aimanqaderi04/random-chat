const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;


// =====================================================
// ORDNER
// =====================================================

const publicFolder = __dirname;
const uploadFolder = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder, {
        recursive: true
    });
}


// =====================================================
// EXPRESS
// =====================================================

app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(
    express.static(publicFolder)
);


// =====================================================
// DATEIUPLOAD
// =====================================================

const storage = multer.diskStorage({

    destination: (req, file, callback) => {

        callback(
            null,
            uploadFolder
        );

    },

    filename: (req, file, callback) => {

        const extension =
            path.extname(
                file.originalname
            );

        const randomName =
            crypto
                .randomBytes(24)
                .toString("hex");

        callback(
            null,
            randomName + extension
        );

    }

});


const upload = multer({

    storage: storage,

    limits: {

        fileSize:
            10 * 1024 * 1024

    }

});


// =====================================================
// RANDOM CHAT
// =====================================================

const waitingUsers =
    new Set();

const activeChats =
    new Map();


// =====================================================
// BENUTZER-ID
// =====================================================
//
// permanentId -> socket.id
//
// Eine Browser-ID kann dadurch
// einem aktuell verbundenen Socket
// zugeordnet werden.
//

const onlineUsers =
    new Map();


// socket.id -> permanentId

const socketUserIds =
    new Map();


// =====================================================
// BLOCKIERUNGEN
// =====================================================
//
// permanentId -> Set mit permanentIds
//
// Dadurch bleibt eine Blockierung
// auch nach einer neuen Verbindung erhalten.
//

const blockedUsers =
    new Map();


// =====================================================
// MELDUNGEN / SPERREN
// =====================================================
//
// permanentId -> {
//     until,
//     reporterIds
// }
//

const userReports =
    new Map();


// =====================================================
// DATEIEN
// =====================================================
//
// socket.id -> Set(filename)
//

const chatFiles =
    new Map();


// fileToken -> Datei-Informationen

const fileTokens =
    new Map();


// =====================================================
// HILFSFUNKTIONEN
// =====================================================

function getPartner(socketId) {

    return activeChats.get(
        socketId
    ) || null;

}


function getPermanentId(socketId) {

    return socketUserIds.get(
        socketId
    ) || null;

}


function isUserBlocked(
    permanentId,
    otherPermanentId
) {

    if (
        !permanentId ||
        !otherPermanentId
    ) {
        return false;
    }


    const blocked =
        blockedUsers.get(
            permanentId
        );


    if (!blocked) {
        return false;
    }


    return blocked.has(
        otherPermanentId
    );

}


function isUserBanned(
    permanentId
) {

    if (!permanentId) {
        return false;
    }


    const report =
        userReports.get(
            permanentId
        );


    if (!report) {
        return false;
    }


    if (
        Date.now() >=
        report.until
    ) {

        userReports.delete(
            permanentId
        );

        return false;

    }


    return true;

}


function getBanRemaining(
    permanentId
) {

    const report =
        userReports.get(
            permanentId
        );


    if (!report) {
        return 0;
    }


    return Math.max(
        0,
        report.until -
        Date.now()
    );

}


// =====================================================
// PARTNER SUCHEN
// =====================================================

function findRandomPartner(
    socket
) {

    const permanentId =
        getPermanentId(
            socket.id
        );


    const available = [
        ...waitingUsers
    ].filter(
        id => {

            if (
                id ===
                socket.id
            ) {
                return false;
            }


            const otherSocket =
                io.sockets.sockets.get(
                    id
                );


            if (!otherSocket) {
                return false;
            }


            const otherPermanentId =
                getPermanentId(
                    id
                );


            if (
                !otherPermanentId
            ) {
                return false;
            }


            // Gesperrte Personen
            if (
                isUserBanned(
                    otherPermanentId
                )
            ) {

                return false;

            }


            if (
                isUserBanned(
                    permanentId
                )
            ) {

                return false;

            }


            // Blockierung prüfen
            if (
                isUserBlocked(
                    permanentId,
                    otherPermanentId
                )
            ) {

                return false;

            }


            if (
                isUserBlocked(
                    otherPermanentId,
                    permanentId
                )
            ) {

                return false;

            }


            return true;

        }
    );


    if (
        available.length ===
        0
    ) {

        return null;

    }


    const randomIndex =
        Math.floor(
            Math.random() *
            available.length
        );


    return available[
        randomIndex
    ];

}


// =====================================================
// CHAT-DATEIEN LÖSCHEN
// =====================================================

function deleteChatFiles(
    socketId
) {

    const files =
        chatFiles.get(
            socketId
        );


    if (!files) {
        return;
    }


    for (
        const filename
        of files
    ) {

        const filePath =
            path.join(
                uploadFolder,
                filename
            );


        try {

            if (
                fs.existsSync(
                    filePath
                )
            ) {

                fs.unlinkSync(
                    filePath
                );

            }

        } catch (
            error
        ) {

            console.error(
                "Fehler beim Löschen:",
                error
            );

        }


        // Alle Tokens dieser Datei löschen
        for (
            const [
                token,
                info
            ]
            of fileTokens
        ) {

            if (
                info.filename ===
                filename
            ) {

                fileTokens.delete(
                    token
                );

            }

        }

    }


    chatFiles.delete(
        socketId
    );

}


// =====================================================
// CHAT VERLASSEN
// =====================================================

function leaveChat(
    socket
) {

    const partnerId =
        activeChats.get(
            socket.id
        );


    if (!partnerId) {
        return;
    }


    activeChats.delete(
        socket.id
    );

    activeChats.delete(
        partnerId
    );


    deleteChatFiles(
        socket.id
    );

    deleteChatFiles(
        partnerId
    );


    const partnerSocket =
        io.sockets.sockets.get(
            partnerId
        );


    if (
        partnerSocket
    ) {

        partnerSocket.emit(
            "partner left"
        );

    }

}


// =====================================================
// NEUEN PARTNER SUCHEN
// =====================================================

function findNewPartner(
    socket
) {

    waitingUsers.delete(
        socket.id
    );


    const permanentId =
        getPermanentId(
            socket.id
        );


    // Ist der Benutzer gesperrt?
    if (
        isUserBanned(
            permanentId
        )
    ) {

        const remaining =
            getBanRemaining(
                permanentId
            );


        socket.emit(
            "user banned",
            {
                remaining:
                    remaining
            }
        );


        return;

    }


    const partnerId =
        findRandomPartner(
            socket
        );


    if (!partnerId) {

        waitingUsers.add(
            socket.id
        );


        socket.emit(
            "waiting"
        );


        return;

    }


    waitingUsers.delete(
        partnerId
    );


    activeChats.set(
        socket.id,
        partnerId
    );

    activeChats.set(
        partnerId,
        socket.id
    );


    chatFiles.set(
        socket.id,
        new Set()
    );

    chatFiles.set(
        partnerId,
        new Set()
    );


    socket.emit(
        "partner found"
    );


    io.to(
        partnerId
    ).emit(
        "partner found"
    );


    console.log(
        `🎲 Random Chat: ${socket.id} ↔ ${partnerId}`
    );

}


// =====================================================
// SOCKET.IO
// =====================================================

io.on(
    "connection",
    socket => {

        console.log(
            "🟢 Neue Person:",
            socket.id
        );


        // -------------------------------------------------
        // BENUTZER-ID REGISTRIEREN
        // -------------------------------------------------

        socket.on(
            "register user",
            permanentId => {

                if (
                    typeof permanentId !==
                    "string"
                ) {
                    return;
                }


                permanentId =
                    permanentId.trim();


                if (
                    permanentId.length <
                    10 ||
                    permanentId.length >
                    200
                ) {

                    return;

                }


                // Alte Verbindung derselben ID
                const oldSocketId =
                    onlineUsers.get(
                        permanentId
                    );


                if (
                    oldSocketId &&
                    oldSocketId !==
                    socket.id
                ) {

                    const oldSocket =
                        io.sockets.sockets.get(
                            oldSocketId
                        );


                    if (
                        oldSocket
                    ) {

                        oldSocket.emit(
                            "duplicate connection"
                        );

                    }

                }


                onlineUsers.set(
                    permanentId,
                    socket.id
                );


                socketUserIds.set(
                    socket.id,
                    permanentId
                );


                if (
                    !blockedUsers.has(
                        permanentId
                    )
                ) {

                    blockedUsers.set(
                        permanentId,
                        new Set()
                    );

                }


                console.log(
                    `🆔 Benutzer-ID: ${permanentId}`
                );


                // Prüfen, ob gesperrt
                if (
                    isUserBanned(
                        permanentId
                    )
                ) {

                    socket.emit(
                        "user banned",
                        {
                            remaining:
                                getBanRemaining(
                                    permanentId
                                )
                        }
                    );

                }

            }
        );


        // -------------------------------------------------
        // PARTNER SUCHEN
        // -------------------------------------------------

        socket.on(
            "find partner",
            () => {

                waitingUsers.delete(
                    socket.id
                );


                leaveChat(
                    socket
                );


                findNewPartner(
                    socket
                );

            }
        );


        // -------------------------------------------------
        // NACHRICHT
        // -------------------------------------------------

        socket.on(
            "chat message",
            message => {

                const partnerId =
                    activeChats.get(
                        socket.id
                    );


                if (!partnerId) {
                    return;
                }


                if (
                    typeof message !==
                    "string"
                ) {

                    return;

                }


                const cleanMessage =
                    message.trim();


                if (
                    !cleanMessage
                ) {

                    return;

                }


                if (
                    cleanMessage.length >
                    2000
                ) {

                    socket.emit(
                        "message error",
                        "Die Nachricht ist zu lang."
                    );


                    return;

                }


                io.to(
                    partnerId
                ).emit(
                    "chat message",
                    cleanMessage
                );

            }
        );


        // -------------------------------------------------
        // NÄCHSTER PARTNER
        // -------------------------------------------------

        socket.on(
            "next partner",
            () => {

                const partnerId =
                    activeChats.get(
                        socket.id
                    );


                if (
                    partnerId
                ) {

                    activeChats.delete(
                        socket.id
                    );

                    activeChats.delete(
                        partnerId
                    );


                    deleteChatFiles(
                        socket.id
                    );

                    deleteChatFiles(
                        partnerId
                    );


                    const partnerSocket =
                        io.sockets.sockets.get(
                            partnerId
                        );


                    if (
                        partnerSocket
                    ) {

                        partnerSocket.emit(
                            "partner left"
                        );

                    }

                }


                findNewPartner(
                    socket
                );

            }
        );


        // -------------------------------------------------
        // CHAT VERLASSEN
        // -------------------------------------------------

        socket.on(
            "leave chat",
            () => {

                waitingUsers.delete(
                    socket.id
                );


                leaveChat(
                    socket
                );


                socket.emit(
                    "chat left"
                );

            }
        );


        // -------------------------------------------------
        // BLOCKIEREN
        // -------------------------------------------------

        socket.on(
            "block partner",
            () => {

                const partnerId =
                    activeChats.get(
                        socket.id
                    );


                if (!partnerId) {

                    socket.emit(
                        "chat left"
                    );

                    return;

                }


                const myId =
                    getPermanentId(
                        socket.id
                    );


                const partnerPermanentId =
                    getPermanentId(
                        partnerId
                    );


                if (
                    myId &&
                    partnerPermanentId
                ) {

                    if (
                        !blockedUsers.has(
                            myId
                        )
                    ) {

                        blockedUsers.set(
                            myId,
                            new Set()
                        );

                    }


                    blockedUsers
                        .get(myId)
                        .add(
                            partnerPermanentId
                        );

                }


                activeChats.delete(
                    socket.id
                );

                activeChats.delete(
                    partnerId
                );


                deleteChatFiles(
                    socket.id
                );

                deleteChatFiles(
                    partnerId
                );


                const partnerSocket =
                    io.sockets.sockets.get(
                        partnerId
                    );


                if (
                    partnerSocket
                ) {

                    partnerSocket.emit(
                        "partner blocked"
                    );

                }


                socket.emit(
                    "chat left"
                );

            }
        );


        // -------------------------------------------------
        // MELDEN
        // -------------------------------------------------

        socket.on(
            "report partner",
            data => {

                const partnerId =
                    activeChats.get(
                        socket.id
                    );


                if (!partnerId) {
                    return;
                }


                const reporterId =
                    getPermanentId(
                        socket.id
                    );


                const reportedId =
                    getPermanentId(
                        partnerId
                    );


                if (
                    !reporterId ||
                    !reportedId
                ) {

                    return;

                }


                let reason =
                    "Nicht angegeben";

                let description =
                    "";


                if (
                    typeof data ===
                    "string"
                ) {

                    reason =
                        data.trim();

                } else if (
                    data &&
                    typeof data ===
                    "object"
                ) {

                    if (
                        typeof data.reason ===
                        "string"
                    ) {

                        reason =
                            data.reason.trim();

                    }


                    if (
                        typeof data.description ===
                        "string"
                    ) {

                        description =
                            data.description.trim();

                    }

                }


                if (
                    reason.length >
                    200
                ) {

                    reason =
                        reason.substring(
                            0,
                            200
                        );

                }


                if (
                    description.length >
                    1000
                ) {

                    description =
                        description.substring(
                            0,
                            1000
                        );

                }


                console.log(
                    "================================"
                );

                console.log(
                    "⚠️ NEUE MELDUNG"
                );

                console.log(
                    "Melder:",
                    reporterId
                );

                console.log(
                    "Gemeldeter:",
                    reportedId
                );

                console.log(
                    "Grund:",
                    reason
                );

                console.log(
                    "Beschreibung:",
                    description
                );

                console.log(
                    "================================"
                );


                // 2 Stunden sperren
                const until =
                    Date.now() +
                    (
                        2 *
                        60 *
                        60 *
                        1000
                    );


                userReports.set(
                    reportedId,
                    {
                        until:
                            until,

                        reporterIds:
                            new Set([
                                reporterId
                            ]),

                        reason:
                            reason,

                        description:
                            description,

                        createdAt:
                            Date.now()
                    }
                );


                // Melder blockiert den gemeldeten Benutzer
                if (
                    !blockedUsers.has(
                        reporterId
                    )
                ) {

                    blockedUsers.set(
                        reporterId,
                        new Set()
                    );

                }


                blockedUsers
                    .get(reporterId)
                    .add(
                        reportedId
                    );


                // Chat beenden
                activeChats.delete(
                    socket.id
                );

                activeChats.delete(
                    partnerId
                );


                deleteChatFiles(
                    socket.id
                );

                deleteChatFiles(
                    partnerId
                );


                // Gemeldeten Benutzer informieren
                const partnerSocket =
                    io.sockets.sockets.get(
                        partnerId
                    );


                if (
                    partnerSocket
                ) {

                    partnerSocket.emit(
                        "user banned",
                        {
                            remaining:
                                2 *
                                60 *
                                60 *
                                1000
                        }
                    );

                }


                // Melder bekommt Bestätigung
                socket.emit(
                    "report received",
                    {
                        success:
                            true
                    }
                );


                socket.emit(
                    "chat left"
                );

            }
        );


        // -------------------------------------------------
        // DATEI-UPLOAD SOCKET
        // -------------------------------------------------

        socket.on(
            "upload file",
            () => {

                /*
                 * Der eigentliche Upload
                 * erfolgt über POST /upload.
                 */

                console.log(
                    "📎 Datei-Upload:",
                    socket.id
                );

            }
        );


        // -------------------------------------------------
        // DISCONNECT
        // -------------------------------------------------

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "🔴 Person getrennt:",
                    socket.id
                );


                waitingUsers.delete(
                    socket.id
                );


                leaveChat(
                    socket
                );


                const permanentId =
                    socketUserIds.get(
                        socket.id
                    );


                if (
                    permanentId
                ) {

                    if (
                        onlineUsers.get(
                            permanentId
                        ) ===
                        socket.id
                    ) {

                        onlineUsers.delete(
                            permanentId
                        );

                    }

                }


                socketUserIds.delete(
                    socket.id
                );

            }
        );

    }
);


// =====================================================
// HTTP DATEIUPLOAD
// =====================================================

app.post(
    "/upload",
    (req, res, next) => {

        upload.single(
            "file"
        )(
            req,
            res,
            error => {

                if (error) {

                    if (
                        error.code ===
                        "LIMIT_FILE_SIZE"
                    ) {

                        return res
                            .status(413)
                            .json({
                                error:
                                    "Die Datei ist zu groß. Maximum: 10 MB."
                            });

                    }


                    console.error(
                        "Upload-Fehler:",
                        error
                    );


                    return res
                        .status(400)
                        .json({
                            error:
                                "Datei konnte nicht hochgeladen werden."
                        });

                }


                next();

            }
        );

    },
    (req, res) => {

        try {

            const socketId =
                req.body.socketId;


            if (
                typeof socketId !==
                "string"
            ) {

                if (
                    req.file
                ) {

                    try {

                        fs.unlinkSync(
                            req.file.path
                        );

                    } catch {}

                }


                return res
                    .status(400)
                    .json({
                        error:
                            "Ungültige Verbindung."
                    });

            }


            const socket =
                io.sockets.sockets.get(
                    socketId
                );


            if (!socket) {

                if (
                    req.file
                ) {

                    try {

                        fs.unlinkSync(
                            req.file.path
                        );

                    } catch {}

                }


                return res
                    .status(403)
                    .json({
                        error:
                            "Ungültige Verbindung."
                    });

            }


            const partnerId =
                activeChats.get(
                    socketId
                );


            if (!partnerId) {

                if (
                    req.file
                ) {

                    try {

                        fs.unlinkSync(
                            req.file.path
                        );

                    } catch {}

                }


                return res
                    .status(403)
                    .json({
                        error:
                            "Du bist aktuell in keinem Chat."
                    });

            }


            if (
                !req.file
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Keine Datei."
                    });

            }


            const myPermanentId =
                getPermanentId(
                    socketId
                );


            const partnerPermanentId =
                getPermanentId(
                    partnerId
                );


            if (
                isUserBanned(
                    myPermanentId
                )
            ) {

                fs.unlinkSync(
                    req.file.path
                );


                return res
                    .status(403)
                    .json({
                        error:
                            "Du bist momentan gesperrt."
                    });

            }


            if (
                !myPermanentId ||
                !partnerPermanentId
            ) {

                fs.unlinkSync(
                    req.file.path
                );


                return res
                    .status(403)
                    .json({
                        error:
                            "Benutzer nicht registriert."
                    });

            }


            // Chat-Dateien vorbereiten
            if (
                !chatFiles.has(
                    socketId
                )
            ) {

                chatFiles.set(
                    socketId,
                    new Set()
                );

            }


            if (
                !chatFiles.has(
                    partnerId
                )
            ) {

                chatFiles.set(
                    partnerId,
                    new Set()
                );

            }


            chatFiles
                .get(socketId)
                .add(
                    req.file.filename
                );


            chatFiles
                .get(partnerId)
                .add(
                    req.file.filename
                );


            const fileId =
                crypto
                    .randomBytes(32)
                    .toString("hex");


            fileTokens.set(
                fileId,
                {

                    filename:
                        req.file.filename,

                    owner:
                        socketId,

                    partner:
                        partnerId,

                    ownerPermanentId:
                        myPermanentId,

                    partnerPermanentId:
                        partnerPermanentId,

                    originalName:
                        req.file.originalname,

                    mimetype:
                        req.file.mimetype,

                    size:
                        req.file.size,

                    createdAt:
                        Date.now()

                }
            );


            const fileInfo = {

                id:
                    fileId,

                name:
                    req.file.originalname,

                type:
                    req.file.mimetype,

                size:
                    req.file.size,

                url:
                    `/file/${fileId}`

            };


            // Nur der Partner bekommt das
            // "Datei erhalten"-Event
            io.to(
                partnerId
            ).emit(
                "file received",
                fileInfo
            );


            // Absender bekommt Bestätigung
            res.json({

                success:
                    true,

                file:
                    fileInfo

            });


        } catch (
            error
        ) {

            console.error(
                "Upload-Fehler:",
                error
            );


            if (
                req.file
            ) {

                try {

                    fs.unlinkSync(
                        req.file.path
                    );

                } catch {}

            }


            res
                .status(500)
                .json({
                    error:
                        "Datei konnte nicht verarbeitet werden."
                });

        }

    }
);


// =====================================================
// DATEI AUSLIEFERN
// =====================================================

app.get(
    "/file/:id",
    (req, res) => {

        const file =
            fileTokens.get(
                req.params.id
            );


        if (!file) {

            return res
                .status(404)
                .send(
                    "Datei nicht gefunden."
                );

        }


        const socketId =
            req.query.socket;


        if (
            typeof socketId !==
            "string"
        ) {

            return res
                .status(403)
                .send(
                    "Zugriff verweigert."
                );

        }


        const socket =
            io.sockets.sockets.get(
                socketId
            );


        if (!socket) {

            return res
                .status(403)
                .send(
                    "Zugriff verweigert."
                );

        }


        const permanentId =
            getPermanentId(
                socketId
            );


        /*
         * Zugriff nur für die beiden
         * Benutzer dieses Chats.
         */

        if (
            permanentId !==
            file.ownerPermanentId &&
            permanentId !==
            file.partnerPermanentId
        ) {

            return res
                .status(403)
                .send(
                    "Zugriff verweigert."
                );

        }


        /*
         * Zusätzlich prüfen,
         * ob die beiden noch miteinander
         * verbunden sind.
         */

        const currentPartner =
            activeChats.get(
                socketId
            );


        if (
            socketId !==
            file.owner &&
            socketId !==
            file.partner
        ) {

            return res
                .status(403)
                .send(
                    "Zugriff verweigert."
                );

        }


        if (
            currentPartner !==
            file.owner &&
            currentPartner !==
            file.partner
        ) {

            return res
                .status(403)
                .send(
                    "Dieser Chat ist beendet."
                );

        }


        const filePath =
            path.join(
                uploadFolder,
                file.filename
            );


        if (
            !fs.existsSync(
                filePath
            )
        ) {

            fileTokens.delete(
                req.params.id
            );


            return res
                .status(404)
                .send(
                    "Datei nicht gefunden."
                );

        }


        res.setHeader(
            "Content-Type",
            file.mimetype
        );


        res.setHeader(
            "Content-Disposition",
            `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
        );


        res.sendFile(
            filePath
        );

    }
);


// =====================================================
// AUTOMATISCHE BEREINIGUNG ABGELAUFENER SPERREN
// =====================================================

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [
                permanentId,
                report
            ]
            of userReports
        ) {

            if (
                now >=
                report.until
            ) {

                userReports.delete(
                    permanentId
                );


                console.log(
                    `🟢 2-Stunden-Sperre beendet: ${permanentId}`
                );

            }

        }

    },
    60 * 1000
);


// =====================================================
// SERVER START
// =====================================================

server.listen(
    PORT,
    () => {

        console.log(
            ""
        );

        console.log(
            "===================================="
        );

        console.log(
            "🚀 RANDOM CHAT SERVER"
        );

        console.log(
            "===================================="
        );

        console.log(
            `🌐 http://localhost:${PORT}`
        );

        console.log(
            `📁 Uploads: ${uploadFolder}`
        );

        console.log(
            "📦 Maximale Dateigröße: 10 MB"
        );

        console.log(
            "🛡️ Meldesystem: 2 Stunden"
        );

        console.log(
            "🆔 Permanente Browser-ID vorbereitet"
        );

        console.log(
            "===================================="
        );

        console.log(
            ""
        );

    }
);
