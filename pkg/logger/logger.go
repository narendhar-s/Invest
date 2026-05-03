package logger

import (
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var global *zap.Logger

// Init initialises the global zap logger. Call once from main.
func Init(dev bool) {
	var enc zapcore.Encoder
	if dev {
		cfg := zap.NewDevelopmentEncoderConfig()
		cfg.EncodeLevel = zapcore.CapitalColorLevelEncoder
		enc = zapcore.NewConsoleEncoder(cfg)
	} else {
		cfg := zap.NewProductionEncoderConfig()
		cfg.EncodeTime = zapcore.ISO8601TimeEncoder
		enc = zapcore.NewJSONEncoder(cfg)
	}

	core := zapcore.NewCore(enc, zapcore.AddSync(os.Stdout), zapcore.DebugLevel)
	global = zap.New(core, zap.AddCaller(), zap.AddCallerSkip(1))
}

// L returns the global logger. Panics if Init was not called.
func L() *zap.Logger {
	if global == nil {
		Init(true)
	}
	return global
}

func Info(msg string, fields ...zap.Field)  { L().Info(msg, fields...) }
func Error(msg string, fields ...zap.Field) { L().Error(msg, fields...) }
func Warn(msg string, fields ...zap.Field)  { L().Warn(msg, fields...) }
func Debug(msg string, fields ...zap.Field) { L().Debug(msg, fields...) }
func Fatal(msg string, fields ...zap.Field) { L().Fatal(msg, fields...) }

func Sync() { _ = L().Sync() }
