# Clipper Setup

## Face Detection Model

Download the OpenCV DNN face detector model before running:

```bash
mkdir -p src/clipper/models

wget -O src/clipper/models/res10_300x300_ssd_iter_140000.caffemodel \
  https://github.com/opencv/opencv_3rdparty/raw/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel
```

The `deploy.prototxt` is committed to the repo. The `.caffemodel` file (~11MB) is gitignored and must be downloaded on each new deployment.

## Python Dependencies

```bash
pip install opencv-python-headless --break-system-packages
```
