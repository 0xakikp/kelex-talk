#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <unistd.h>

// Native microphone capture compiled into Kelex's main process. TCC therefore
// sees the signed Kelex.app bundle rather than an unbundled helper process.

static AVAudioEngine *gEngine = nil;
static dispatch_queue_t gWriterQueue = nil;
static int gWriteFD = -1;

static void write_all(int fd, const void *bytes, size_t length) {
    const uint8_t *cursor = bytes;
    while (length > 0) {
        ssize_t written = write(fd, cursor, length);
        if (written <= 0) return;
        cursor += written;
        length -= (size_t)written;
    }
}

int kelex_microphone_request_access(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusAuthorized) return 1;
    if (status != AVAuthorizationStatusNotDetermined) return 0;

    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL granted = NO;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
        granted = allowed;
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    return granted ? 1 : 0;
}

int kelex_microphone_start(int write_fd) {
    if (gEngine != nil) return 0;
    if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) {
        return -2;
    }

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate <= 0 || format.channelCount == 0) return -3;

    gWriteFD = write_fd;
    gWriterQueue = dispatch_queue_create("in.akikp.kelex.mic-writer", DISPATCH_QUEUE_SERIAL);

    [input installTapOnBus:0 bufferSize:1024 format:nil block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        (void)when;
        float **channels = buffer.floatChannelData;
        AVAudioFrameCount frames = buffer.frameLength;
        AVAudioChannelCount channel_count = buffer.format.channelCount;
        if (channels == NULL || frames == 0 || channel_count == 0) return;

        NSMutableData *mono = [NSMutableData dataWithLength:(NSUInteger)frames * sizeof(float)];
        float *out = mono.mutableBytes;
        for (AVAudioFrameCount frame = 0; frame < frames; frame++) {
            float sum = 0;
            for (AVAudioChannelCount channel = 0; channel < channel_count; channel++) {
                sum += channels[channel][frame];
            }
            out[frame] = sum / (float)channel_count;
        }

        // Copy before leaving CoreAudio's callback, then write outside its
        // real-time thread so slow pipe consumers cannot stall capture.
        dispatch_async(gWriterQueue, ^{
            if (gWriteFD >= 0) write_all(gWriteFD, mono.bytes, mono.length);
        });
    }];

    NSError *error = nil;
    [engine prepare];
    if (![engine startAndReturnError:&error]) {
        [input removeTapOnBus:0];
        gWriteFD = -1;
        return -4;
    }

    uint32_t sample_rate = (uint32_t)llround(format.sampleRate);
    uint16_t channels = 1;
    write_all(write_fd, &sample_rate, sizeof(sample_rate));
    write_all(write_fd, &channels, sizeof(channels));
    gEngine = engine;
    return 0;
}

void kelex_microphone_stop(void) {
    if (gEngine != nil) {
        [gEngine.inputNode removeTapOnBus:0];
        [gEngine stop];
        gEngine = nil;
    }
    if (gWriteFD >= 0) {
        close(gWriteFD);
        gWriteFD = -1;
    }
    gWriterQueue = nil;
}
