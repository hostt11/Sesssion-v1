import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';
import { upload } from './mega.js';

const router = express.Router();

// Configuration
const SESSION_TIMEOUT = 30000; // 30 secondes
const CLEANUP_DELAY = 2000;
const MAX_RETRIES = 3;

// Stockage des sessions actives
const activeSessions = new Map();

// Fonction utilitaire sécurisée pour supprimer un fichier
async function removeFile(filePath) {
    try {
        await fs.rm(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`Erreur lors de la suppression de ${filePath}:`, error.message);
        return false;
    }
}

// Génération d'ID sécurisé
function generateSecureId(length = 10) {
    return crypto.randomBytes(length).toString('hex');
}

// Validation du numéro de téléphone
function validatePhoneNumber(number) {
    if (!number || typeof number !== 'string') {
        return null;
    }
    const cleaned = number.replace(/[^0-9]/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null;
    }
    return cleaned;
}

// Nettoyage des event listeners
function cleanupEventListeners(socket, events) {
    events.forEach(event => {
        socket.ev.removeAllListeners(event);
    });
}

// Fonction principale de création de session
async function initiateSession(sessionId, phoneNumber, res) {
    const sessionDir = path.join('./sessions', sessionId);
    let socket = null;
    let retryCount = 0;
    let isResponseSent = false;

    async function createSocket() {
        try {
            await fs.mkdir(sessionDir, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            
            socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                defaultQueryTimeoutMs: 15000,
                keepAliveIntervalMs: 10000,
            });

            activeSessions.set(sessionId, {
                socket,
                saveCreds,
                createdAt: Date.now(),
                phoneNumber
            });

            return { socket, saveCreds };
        } catch (error) {
            console.error(`Erreur création socket (${sessionId}):`, error.message);
            throw error;
        }
    }

    async function handleConnection(socket, saveCreds) {
        return new Promise((resolve, reject) => {
            // Gestion du code de pairage
            if (!socket.authState.creds.registered) {
                socket.requestPairingCode(phoneNumber)
                    .then(code => {
                        console.log(`Code de pairage pour ${phoneNumber}:`, code);
                        // Envoyer le code dans la réponse si pas encore envoyé
                        if (!isResponseSent && res && !res.headersSent) {
                            isResponseSent = true;
                            res.status(200).json({ 
                                code: code,
                                status: 'pairing_code_sent'
                            });
                        }
                    })
                    .catch(error => {
                        console.error(`Erreur pairage ${sessionId}:`, error);
                        if (!isResponseSent && res && !res.headersSent) {
                            isResponseSent = true;
                            res.status(503).json({ 
                                code: 'Service Unavailable',
                                error: 'Failed to request pairing code'
                            });
                        }
                        reject(error);
                    });
            } else {
                // Si déjà enregistré, envoyer une réponse immédiate
                if (!isResponseSent && res && !res.headersSent) {
                    isResponseSent = true;
                    res.status(200).json({ 
                        status: 'already_registered',
                        message: 'Device already registered'
                    });
                }
            }

            const connectionHandler = async (update) => {
                const { connection, lastDisconnect } = update;

                try {
                    if (connection === "open") {
                        console.log(`Session ${sessionId} connectée avec succès`);
                        
                        await delay(3000);
                        
                        const credsPath = path.join(sessionDir, 'creds.json');
                        const credsContent = await fs.readFile(credsPath);
                        
                        const megaUrl = await upload(credsContent, `${sessionId}.json`);
                        let sessionString = megaUrl.replace('https://mega.nz/file/', '');
                        sessionString = `KERM-MD-V1~${sessionString}`;
                        
                        const userJid = jidNormalizedUser(`${phoneNumber}@s.whatsapp.net`);
                        await socket.sendMessage(userJid, { 
                            text: sessionString,
                            ephemeralExpiration: 86400
                        });
                        
                        await socket.sendMessage(userJid, { 
                            text: '✅ *Session générée avec succès!*\n\n' +
                                  '⚠️ *Important:* Ne partagez jamais cette session avec personne.\n\n' +
                                  '📱 *Bot:* KERM MD V1\n' +
                                  '🔗 *Channel:* https://whatsapp.com/channel/0029Vafn6hc7DAX3fzsKtn45\n\n' +
                                  '©️ KGTECH',
                            ephemeralExpiration: 86400
                        });
                        
                        await delay(CLEANUP_DELAY);
                        await cleanupSession(sessionId);
                        
                        resolve({ success: true, sessionString });
                        
                    } else if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        
                        if (statusCode !== 401 && retryCount < MAX_RETRIES) {
                            retryCount++;
                            console.log(`Session ${sessionId}: Reconnexion tentative ${retryCount}/${MAX_RETRIES}`);
                            await delay(5000);
                            const { socket: newSocket, saveCreds: newSaveCreds } = await createSocket();
                            await handleConnection(newSocket, newSaveCreds);
                        } else {
                            // Envoyer une erreur 503 si la connexion échoue
                            if (!isResponseSent && res && !res.headersSent) {
                                isResponseSent = true;
                                res.status(503).json({ 
                                    code: 'Service Unavailable',
                                    error: 'Connection failed'
                                });
                            }
                            reject(new Error(`Session fermée: ${lastDisconnect?.error?.message || 'Unknown error'}`));
                        }
                    }
                } catch (error) {
                    console.error(`Erreur handler session ${sessionId}:`, error);
                    if (!isResponseSent && res && !res.headersSent) {
                        isResponseSent = true;
                        res.status(503).json({ 
                            code: 'Service Unavailable',
                            error: error.message
                        });
                    }
                    reject(error);
                }
            };

            socket.ev.on('connection.update', connectionHandler);
            socket.ev.on('creds.update', saveCreds);
            
            activeSessions.set(sessionId, {
                ...activeSessions.get(sessionId),
                handlers: { connectionHandler }
            });
        });
    }

    try {
        const { socket: newSocket, saveCreds: newSaveCreds } = await createSocket();
        
        // Timeout global pour la session
        const timeoutId = setTimeout(() => {
            if (!isResponseSent && res && !res.headersSent) {
                isResponseSent = true;
                res.status(503).json({ 
                    code: 'Service Unavailable',
                    error: 'Session timeout'
                });
            }
            cleanupSession(sessionId);
        }, SESSION_TIMEOUT);
        
        await handleConnection(newSocket, newSaveCreds);
        clearTimeout(timeoutId);
        
    } catch (error) {
        if (!isResponseSent && res && !res.headersSent) {
            res.status(503).json({ 
                code: 'Service Unavailable',
                error: error.message
            });
        }
        await cleanupSession(sessionId);
        throw error;
    }
}

// Nettoyage d'une session
async function cleanupSession(sessionId) {
    const session = activeSessions.get(sessionId);
    
    if (session) {
        if (session.socket && session.handlers) {
            cleanupEventListeners(session.socket, ['connection.update', 'creds.update']);
        }
        
        if (session.socket && session.socket.end) {
            await session.socket.end();
        }
        
        const sessionDir = path.join('./sessions', sessionId);
        await removeFile(sessionDir);
        
        activeSessions.delete(sessionId);
        
        console.log(`Session ${sessionId} nettoyée avec succès`);
    }
}

// Route principale - Format GET comme dans l'original
router.get('/', async (req, res) => {
    let num = req.query.number;
    let sessionId = null;
    
    try {
        // Validation du numéro
        const validatedNumber = validatePhoneNumber(num);
        if (!validatedNumber) {
            return res.status(400).json({ 
                error: 'Numéro de téléphone invalide'
            });
        }
        
        // Générer un ID de session unique
        sessionId = generateSecureId();
        
        console.log(`Démarrage de la session ${sessionId} pour ${validatedNumber}`);
        
        // Lancer la création de session
        await initiateSession(sessionId, validatedNumber, res);
        
    } catch (error) {
        console.error(`Erreur génération session ${sessionId || 'unknown'}:`, error);
        
        // S'assurer qu'une réponse est envoyée si ce n'est pas déjà fait
        if (!res.headersSent) {
            res.status(503).json({ 
                code: 'Service Unavailable',
                error: error.message
            });
        }
        
        // Nettoyer en cas d'erreur
        if (sessionId) {
            await cleanupSession(sessionId);
        }
    }
});

// Route alternative en POST pour plus de sécurité
router.post('/', async (req, res) => {
    let { number: num } = req.body;
    let sessionId = null;
    
    try {
        const validatedNumber = validatePhoneNumber(num);
        if (!validatedNumber) {
            return res.status(400).json({ 
                error: 'Numéro de téléphone invalide'
            });
        }
        
        sessionId = generateSecureId();
        console.log(`Démarrage de la session ${sessionId} pour ${validatedNumber}`);
        
        await initiateSession(sessionId, validatedNumber, res);
        
    } catch (error) {
        console.error(`Erreur génération session ${sessionId || 'unknown'}:`, error);
        
        if (!res.headersSent) {
            res.status(503).json({ 
                code: 'Service Unavailable',
                error: error.message
            });
        }
        
        if (sessionId) {
            await cleanupSession(sessionId);
        }
    }
});

// Route pour vérifier l'état d'une session
router.get('/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            exists: false,
            message: 'Session non trouvée ou déjà nettoyée'
        });
    }
    
    res.status(200).json({
        exists: true,
        createdAt: session.createdAt,
        phoneNumber: session.phoneNumber,
        isConnected: session.socket?.user ? true : false
    });
});

// Middleware de nettoyage périodique des sessions expirées
setInterval(async () => {
    const now = Date.now();
    const EXPIRATION_TIME = 5 * 60 * 1000; // 5 minutes
    
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.createdAt > EXPIRATION_TIME) {
            console.log(`Nettoyage session expirée: ${sessionId}`);
            await cleanupSession(sessionId);
        }
    }
}, 60000);

export default router;
