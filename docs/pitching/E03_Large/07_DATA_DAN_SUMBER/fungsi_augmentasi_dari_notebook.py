def augment_pil(im, cfg):
    a, size = (cfg['augment'], cfg['image_size'])
    if random.random() < a['crop_p']:
        i, j, h, w = T.RandomResizedCrop.get_params(im, a['crop_scale'], a['crop_ratio'])
        im = TF.resized_crop(im, i, j, h, w, [size, size], InterpolationMode.BILINEAR, antialias=True)
    if random.random() < a['flip_p']:
        im = TF.hflip(im)
    if random.random() < a['affine_p']:
        choice = random.choice(['translation', 'shear', 'rotation_shear'])
        angle, translate, shear = (0.0, [0, 0], [0.0, 0.0])
        if choice == 'translation':
            translate = [round(random.uniform(-a['translate'], a['translate']) * size) for _ in range(2)]
        elif choice == 'shear':
            shear[0] = random.uniform(-a['shear'], a['shear'])
        else:
            angle = random.uniform(-a['rotation'], a['rotation'])
            shear[0] = random.uniform(-a['rotation_shear'], a['rotation_shear'])
        pad = math.ceil(size * 0.25)
        im = TF.pad(im, [pad, pad, pad, pad], padding_mode='reflect')
        im = TF.affine(im, angle, translate, 1.0, shear, InterpolationMode.BILINEAR)
        im = TF.center_crop(im, [size, size])
    if random.random() < a['contrast_p']:
        im = TF.adjust_contrast(im, random.uniform(*a['contrast']))
    if random.random() < a['blur_p']:
        im = TF.gaussian_blur(im, a['blur_kernel'], random.uniform(*a['blur_sigma']))
    if a['brightness'] and random.random() < a['brightness_p']:
        im = TF.adjust_brightness(im, random.uniform(*a['brightness_range']))
    return im
