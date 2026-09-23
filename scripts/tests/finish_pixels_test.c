#include "FinishPixels.h"
#include <assert.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include <string.h>

#define W 96
#define H 32
#define STRIDE (W * 4 + 8)
static unsigned char original[H * STRIDE], output[H * STRIDE];
static void fixture(void) {
    memset(original, 173, sizeof(original));
    for (int y=0; y<H; ++y) for (int x=0; x<W; ++x) {
        unsigned char *p = original + y*STRIDE+x*4;
        int a = y == 0 ? 0 : y < 5 ? 128 : 255;
        int value = x < 32 ? 45 : x < 64 ? 128 : 210;
        value += x % 4 < 2 ? 12 : -12;
        p[0] = (unsigned char)(value*a/255);
        p[1] = (unsigned char)((value-12)*a/255);
        p[2] = (unsigned char)((value+12)*a/255);
        p[3] = (unsigned char)a;
    }
}
static unsigned char *pixel_guard(void) { static unsigned char pixel[4]={1,2,3,255}; return pixel; }
static void run(int kind, float amount, float sh, float mid, float hi, int type, float ps, float ph) {
    memcpy(output,original,sizeof(output));
    assert(finish_apply(output,W,H,STRIDE,kind,amount,sh,mid,hi,4,0,2,type,ps,ph));
}
static int difference(int lo, int hi) {
    int sum=0;
    for (int y=5; y<H; ++y) for (int x=lo; x<hi; ++x)
        sum += abs((int)output[y*STRIDE+x*4] - (int)original[y*STRIDE+x*4]);
    return sum;
}
int main(void) {
    fixture();
    for (int kind=0;kind<18;++kind) {
        run(kind,0,1,1,1,0,0,0);
        assert(memcmp(output,original,sizeof(output))==0);
        run(kind,1,1,1,1,0,0,0);
        assert(difference(0,W)>0);
        for (int y=0;y<H;++y) {
            for (int x=0;x<W;++x) {
                int i=y*STRIDE+x*4;
                assert(output[i+3]==original[i+3]);
                for(int c=0;c<3;++c) assert(output[i+c]<=output[i+3]);
            }
            assert(memcmp(output+y*STRIDE+W*4,original+y*STRIDE+W*4,8)==0);
        }
    }
    // Contrast controls address separate tonal regions, not global brightness.
    run(0,1,1,0,0,0,0,0);
    assert(difference(4,28)>0 && difference(68,92)==0);
    run(0,1,0,0,1,0,0,0);
    assert(difference(4,28)==0 && difference(68,92)>0);
    run(0,1,0,0,0,0,0,0);
    assert(memcmp(output,original,sizeof(output))==0);
    // Positive contrast expands texture, negative contrast softens it.
    int i=16*STRIDE+44*4, j=i+8;
    int before=original[i]-original[j];
    run(0,1,0,1,0,0,0,0);
    assert(output[i]-output[j]>before);
    run(0,1,0,-1,0,0,0,0);
    assert(output[i]-output[j]<before);
    unsigned char modes[5][sizeof(output)];
    for(int mode=0;mode<5;++mode) {
        run(0,1,1,1,1,mode,0,0);
        memcpy(modes[mode],output,sizeof(output));
        for(int prior=0;prior<mode;++prior) assert(memcmp(modes[prior],modes[mode],sizeof(output))!=0);
    }
    // Protection lifts shadows and pulls highlights back with neutral contrast controls.
    run(0,1,0,0,0,0,1,1);
    assert(output[16*STRIDE+8*4]>original[16*STRIDE+8*4]);
    assert(output[16*STRIDE+88*4]<original[16*STRIDE+88*4]);
    // A flat semitransparent shape must not gain dark fringes from transparent neighbours.
    memset(original,0,sizeof(original));
    for(int y=8;y<24;++y) for(int x=20;x<76;++x) {
        int i=y*STRIDE+x*4; original[i]=original[i+1]=original[i+2]=64; original[i+3]=128;
    }
    run(0,1,1,1,1,0,0,0);
    assert(memcmp(output,original,sizeof(output))==0);
    // Lens effects change color/detail, not coverage: flat translucent objects must stay flat
    // when sampled across their alpha edge, including when a fringe samples fully transparent pixels.
    for (int kind=10;kind<=11;++kind) {
        run(kind,1,1,1,1,0,0,0);
        assert(memcmp(output,original,sizeof(output))==0);
    }
    // A crop processed as a region matches the whole image: exactly for Vignette, and for spatial
    // effects inside a margin of three box radii (the reach of the three blur passes).
    fixture();
    for (int y=0;y<H;++y) for (int x=0;x<W;++x) original[y*STRIDE+x*4+3]=255;
    for (int kind=0;kind<15;++kind) {
        memcpy(output,original,sizeof(output));
        assert(finish_apply(output,W,H,STRIDE,kind,1,1,1,1,3,.2f,1,0,.2f,.2f));
        enum { X0=20, Y0=6, CW=60, CH=20 };
        static unsigned char crop[CH*CW*4];
        for (int y=0;y<CH;++y) memcpy(crop+y*CW*4,original+(Y0+y)*STRIDE+X0*4,CW*4);
        assert(finish_apply_region(crop,CW,CH,CW*4,W,H,X0,Y0,kind,1,1,1,1,3,.2f,1,0,.2f,.2f));
        FinishEffectSettings probe={kind,1,1,1,1,3,.2f,1,0,.2f,.2f,0,1,0,0,0};
        int margin = finish_effect_reach(&probe);
        assert(margin == (kind==0 || kind==3 || kind==4 || kind==8 || kind==9 || kind==11 ? 9 : kind==10 ? 5 : 0));
        for (int y=margin;y<CH-margin;++y) for (int x=margin;x<CW-margin;++x) for (int c=0;c<4;++c)
            assert(abs(crop[(y*CW+x)*4+c]-output[(Y0+y)*STRIDE+(X0+x)*4+c])<=1);
    }
    assert(!finish_apply_region(pixel_guard(),1,1,4,1,1,1,0,0,1,1,1,1,1,0,0,0,0,0));
    // Photo realism: sensor grain, micro texture, highlight rolloff, chromatic aberration, lens softness.
    fixture();
    for (int kind=7;kind<12;++kind) {
        FinishEffectSettings e={kind,0,0,0,.5f,2,0,0,0,0,0,7,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&e,1));
        assert(memcmp(output,original,sizeof(output))==0);
        e.amount=1;
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&e,1));
        assert(difference(0,W)>0);
        for (int y=0;y<H;++y) {
            for (int x=0;x<W;++x) {
                int i=y*STRIDE+x*4;
                assert(output[i+3]==original[i+3]);
                for(int c=0;c<3;++c) assert(output[i+c]<=output[i+3]);
            }
            assert(memcmp(output+y*STRIDE+W*4,original+y*STRIDE+W*4,8)==0);
        }
    }
    {   // Grain follows its seed and sits on whole-image pixels: a crop matches exactly.
        FinishEffectSettings grain={7,1,0,0,0,1.5f,0,0,0,0,0,7,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&grain,1));
        static unsigned char first[H*STRIDE]; memcpy(first,output,sizeof(output));
        enum { X0=10, Y0=7, CW=50, CH=20 };
        static unsigned char crop[CH*CW*4];
        for (int y=0;y<CH;++y) memcpy(crop+y*CW*4,original+(Y0+y)*STRIDE+X0*4,CW*4);
        assert(finish_apply_stack(crop,CW,CH,CW*4,W,H,X0,Y0,&grain,1));
        for (int y=0;y<CH;++y) assert(memcmp(crop+y*CW*4,first+(Y0+y)*STRIDE+X0*4,CW*4)==0);
        grain.seed=8;
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&grain,1));
        assert(memcmp(output,first,sizeof(output))!=0);
    }
    {   // Rolloff pulls bright tones down and leaves dark ones; micro texture widens fine local contrast.
        FinishEffectSettings rolloff={9,1,0,0,0,4,0,0,0,0,0,0,1,0,0,0}, texture={8,1,0,0,0,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&rolloff,1));
        assert(output[16*STRIDE+80*4]<original[16*STRIDE+80*4] && output[16*STRIDE+8*4]==original[16*STRIDE+8*4]);
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&texture,1));
        int a=16*STRIDE+44*4, b=a+8;
        assert(output[a]-output[b]>original[a]-original[b]);
    }
    {   // Aberration shifts red and blue apart at the edges, not at the center; softness grows toward the corners.
        memset(original,0,sizeof(original));
        for (int y=0;y<H;++y) for (int x=0;x<W;++x) {
            int i=y*STRIDE+x*4, v=(x/3)%2 ? 220 : 30;
            original[i]=original[i+1]=original[i+2]=(unsigned char)v; original[i+3]=255;
        }
        FinishEffectSettings fringe={10,1,0,0,0,3,0,0,0,0,0,0,1,0,0,0}, soft={11,1,0,0,0,2,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&fringe,1));
        int edge=16*STRIDE+2*4, center=16*STRIDE+49*4; // inside a stripe, beside the image center
        assert(output[edge]!=output[edge+2] && output[edge+1]==original[edge+1]);
        assert(abs(output[center]-output[center+2])<=2);
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&soft,1));
        int corner=0, middle=0;
        for (int x=0;x<12;++x) corner+=abs(output[1*STRIDE+x*4]-original[1*STRIDE+x*4]);
        for (int x=42;x<54;++x) middle+=abs(output[16*STRIDE+x*4]-original[16*STRIDE+x*4]);
        assert(corner>middle);
    }
    // Tiny image, oversized radius and malformed input remain safe.
    unsigned char pixel[4]={80,100,120,128};
    assert(finish_apply(pixel,1,1,4,0,1,1,1,1,100,0,0,0,0,0));
    assert(pixel[0]==80 && pixel[1]==100 && pixel[2]==120 && pixel[3]==128);
    assert(!finish_apply(pixel,1,1,4,0,NAN,1,1,1,1,0,0,0,0,0));
    // Large, valid crop offsets must not overflow the noise lattice even at the smallest grain size.
    assert(finish_apply_region(pixel,1,1,4,INT_MAX,INT_MAX,INT_MAX-1,INT_MAX-1,7,1,0,0,0,.05f,0,0,0,0,0));
    // The stack must validate all inputs before modifying any pixels.
    FinishEffectSettings invalid[]={{1,1,0,0,0,1,0,0,0,0,0,0,1,0,0,0},{0,NAN,0,0,0,1,0,0,0,0,0,0,1,0,0,0}};
    unsigned char saved[4]; memcpy(saved,pixel,4);
    assert(!finish_apply_stack(pixel,1,1,4,1,1,0,0,invalid,2));
    assert(memcmp(saved,pixel,4)==0);
    assert(!finish_apply_stack(pixel,1,1,3,1,1,0,0,NULL,0));
    assert(!finish_apply_stack(pixel,1,1,4,1,1,0,0,NULL,1));
    {   // Split Tone: the highlights warm and the shadows cool, each on its own range.
        fixture();
        for (int y=0;y<H;++y) for (int x=0;x<W;++x) original[y*STRIDE+x*4+3]=255;
        int bright=16*STRIDE+80*4, dark=16*STRIDE+8*4;
        FinishEffectSettings warm={12,1,0,0,1,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&warm,1));
        assert(output[bright]>original[bright] && output[bright+2]<original[bright+2]);
        assert(output[dark]==original[dark]);
        FinishEffectSettings cool={12,1,-1,0,0,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&cool,1));
        assert(output[dark]<original[dark] && output[dark+2]>original[dark+2]);
        assert(output[bright]==original[bright]);
    }
    {   // Graduated Filter: darkens from the edge it is pulled in from, and leaves the far end untouched.
        int top=2*STRIDE+48*4, bottom=(H-2)*STRIDE+48*4;
        FinishEffectSettings grad={13,1,0,.1f,.5f,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&grad,1));
        assert(output[top]<original[top] && output[bottom]==original[bottom]);
        grad.contrast_type=1;
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&grad,1));
        assert(output[top]==original[top] && output[bottom]<original[bottom]);
    }
    {   // Film Response: lifted blacks leave the floor, the shoulder bends the brightest tones down, and
        // neither reaches into the other's end of the scale.
        int bright=16*STRIDE+80*4, dark=16*STRIDE+8*4;
        FinishEffectSettings film={14,1,1,0,0,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&film,1));
        assert(output[dark]>original[dark] && output[bright]==original[bright]);
        film.shadows=0; film.highlights=1;
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&film,1));
        assert(output[bright]<original[bright] && output[dark]==original[dark]);
    }
    {   // The Cinematic Look plays the whole chain from one filter, reaches as far as its parts together,
        // and disappears at zero.
        FinishEffectSettings look={15,1,.6f,.5f,.4f,8,0,0,0,0,0,3,1,0,0,0};
        FinishEffectSettings glow={4,1,0,0,0,8,0,0,0,0,0,0,1,0,0,0};
        assert(finish_effect_reach(&look)>finish_effect_reach(&glow));
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&look,1));
        assert(difference(0,W)>0);
        look.amount=0;
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&look,1));
        assert(memcmp(output,original,sizeof(output))==0);
    }
    {   // A zoomed-in detail of the Cinematic Look matches the whole image outside the reach it reports.
        enum { BW=160, BH=120, BS=BW*4, X0=30, Y0=20, CW=100, CH=80 };
        static unsigned char big[BH*BS], whole[BH*BS], crop[CH*CW*4];
        for (int y=0;y<BH;++y) for (int x=0;x<BW;++x) {
            unsigned char *p=big+y*BS+x*4;
            p[0]=(unsigned char)(x*255/BW); p[1]=(unsigned char)(y*255/BH);
            p[2]=(unsigned char)((x/5+y/5)%2 ? 230 : 40); p[3]=255;
        }
        FinishEffectSettings look={15,1,.5f,.5f,.5f,4,0,0,0,0,0,11,1,0,0,0};
        int margin=finish_effect_reach(&look);
        assert(margin>0 && margin<CH/2);
        memcpy(whole,big,sizeof(big));
        assert(finish_apply_stack(whole,BW,BH,BS,BW,BH,0,0,&look,1));
        for (int y=0;y<CH;++y) memcpy(crop+y*CW*4,big+(Y0+y)*BS+X0*4,CW*4);
        assert(finish_apply_stack(crop,CW,CH,CW*4,BW,BH,X0,Y0,&look,1));
        for (int y=margin;y<CH-margin;++y) for (int x=margin;x<CW-margin;++x) for (int c=0;c<4;++c)
            assert(abs(crop[(y*CW+x)*4+c]-whole[(Y0+y)*BS+(X0+x)*4+c])<=1);
    }
    {   // A preview scales the radii the look sets itself, so its grain and fringe stay photographic.
        FinishEffectSettings full={15,1,.5f,.5f,.5f,20,0,0,0,0,0,2,1,0,0,0}, preview=full;
        preview.radius=5; preview.scale=.25f;
        assert(finish_effect_reach(&preview)<finish_effect_reach(&full));
        assert(finish_effect_reach(&preview)>0);
    }
    {   // Three-Way Color: each range takes its own temperature and its own green-to-magenta tint.
        fixture();
        for (int y=0;y<H;++y) for (int x=0;x<W;++x) original[y*STRIDE+x*4+3]=255;
        int bright=16*STRIDE+80*4, dark=16*STRIDE+8*4;
        FinishEffectSettings wheels={16,1,-.8f,0,.6f,1,0,0,0,0,0,0,1,0,0,0};
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&wheels,1));
        assert(output[bright]>original[bright] && output[dark]<original[dark]);      // warm light, cool shade
        assert(output[bright+2]<original[bright+2] && output[dark+2]>original[dark+2]);
        FinishEffectSettings green={16,1,0,0,0,1,0,0,0,0,0,0,1,0,0,-1};              // green highlights
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,&green,1));
        assert(output[bright+1]>original[bright+1] && output[bright]<original[bright]);
        assert(output[dark+1]==original[dark+1]);
    }
    {   // Highlight Compensation: the top end bends down without turning, a blown area borrows the shape
        // of what surrounds it, and what is dark is left alone.
        enum { BW=120, BH=90, BS=BW*4 };
        static unsigned char big[BH*BS], out2[BH*BS];
        for (int y=0;y<BH;++y) for (int x=0;x<BW;++x) {
            unsigned char *p=big+y*BS+x*4;
            int window = x>30 && x<90 && y>20 && y<70;
            int v = window ? 255 : 40 + (x+y)%12;
            p[0]=(unsigned char)v; p[1]=(unsigned char)(window?250:v); p[2]=(unsigned char)(window?244:v);
            p[3]=255;
        }
        FinishEffectSettings compress={17,1,0,0,1,20,0,0,0,0,0,0,1,0,0,0};
        memcpy(out2,big,sizeof(big));
        assert(finish_apply_stack(out2,BW,BH,BS,BW,BH,0,0,&compress,1));
        int middle=45*BS+60*4, shade=5*BS+5*4;
        assert(out2[middle]<big[middle]);                     // the window comes down
        assert(out2[shade]==big[shade]);                      // the room does not move
        int before=big[middle]-big[middle+2], after=out2[middle]-out2[middle+2];
        assert(abs(after)<=abs(before)+1);                    // and it does not change hue on the way
        FinishEffectSettings recover={17,1,1,0,0,12,0,0,0,0,0,0,1,0,0,0};
        memcpy(out2,big,sizeof(big));
        assert(finish_apply_stack(out2,BW,BH,BS,BW,BH,0,0,&recover,1));
        int edge=25*BS+35*4;
        assert(out2[edge]<big[edge] && out2[middle]<=big[middle]);   // shape comes back from the edges in
        assert(out2[shade]==big[shade]);
        FinishEffectSettings neutral={17,1,0,1,0,12,0,0,0,0,0,0,1,0,0,0};
        memcpy(out2,big,sizeof(big));
        assert(finish_apply_stack(out2,BW,BH,BS,BW,BH,0,0,&neutral,1));
        assert(abs(out2[middle]-out2[middle+2])<abs(big[middle]-big[middle+2]));      // the cast goes
    }
    {   // The expansion is what the stack really runs: applying it one effect at a time, each with its own
        // reach, must land on the same pixels as one call — that is what a caller splitting the work needs.
        fixture();
        for (int y=0;y<H;++y) for (int x=0;x<W;++x) original[y*STRIDE+x*4+3]=255;
        FinishEffectSettings stack[]={{0,1,.3f,.5f,.2f,6,0,0,0,0,0,0,1,0,0,0},
                                      {15,1,.5f,.5f,.5f,5,0,0,0,0,0,4,1,0,0,0},
                                      {6,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0}};
        FinishEffectSettings steps[32];
        size_t made = finish_expand_stack(stack,3,steps,32);
        assert(made>1 && made<=1+9);
        assert(finish_expand_stack(stack,3,steps,2)==0);
        for (size_t i=0;i<made;++i) assert(steps[i].kind!=15 && steps[i].amount>0);
        memcpy(output,original,sizeof(output));
        assert(finish_apply_stack(output,W,H,STRIDE,W,H,0,0,stack,3));
        static unsigned char stepwise[H*STRIDE];
        memcpy(stepwise,original,sizeof(stepwise));
        for (size_t i=0;i<made;++i)
            assert(finish_apply_stack(stepwise,W,H,STRIDE,W,H,0,0,&steps[i],1));
        assert(memcmp(stepwise,output,sizeof(output))==0);
    }
    // An unknown kind and a malformed scale are refused, and neither reaches anywhere.
    FinishEffectSettings unknown={18,1,0,0,0,1,0,0,0,0,0,0,1,0,0,0}, bad_scale={15,1,0,0,0,1,0,0,0,0,0,0,NAN,0,0,0};
    assert(finish_effect_reach(&unknown)==0 && finish_effect_reach(&bad_scale)==0);
    assert(!finish_apply_stack(pixel,1,1,4,1,1,0,0,&unknown,1));
    assert(!finish_apply_stack(pixel,1,1,4,1,1,0,0,&bad_scale,1));
    assert(finish_effect_reach(NULL)==0);
    puts("Render Finish: all 18 effects, identity, alpha, stride, tone isolation, signed contrast, five modes, protection, transparent lens edges, crop consistency, grain coordinates, split tone, graduated filter, film response, the cinematic look's chain, three-way color, highlight compensation, reach, stepwise expansion and atomic input validation passed.");
}
