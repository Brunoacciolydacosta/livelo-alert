const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '../logs');

const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
);

const logger = createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // Terminal
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
      ),
    }),

    // Todos os logs com rotação diária
    new DailyRotateFile({
      dirname: LOGS_DIR,
      filename: 'combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: false,
      maxFiles: '14d',
      auditFile: path.join(LOGS_DIR, '.combined-audit.json'),
    }),

    // Apenas erros com rotação diária
    new DailyRotateFile({
      dirname: LOGS_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: false,
      maxFiles: '14d',
      auditFile: path.join(LOGS_DIR, '.error-audit.json'),
    }),
  ],
});

module.exports = logger;
